-- 0008_scoring_failure_disposition.sql — Phase 3C blocker #4
--
-- record_scoring_failure previously treated every OpenAI failure identically:
-- three strikes, then dead-letter as 'exhausted'. That is correct for
-- transient failures (rate_limit, server_error, network, timeout) but wrong
-- for two other classes:
--
--   permanent, job-specific (refusal, content_filter) — a retry asks the same
--   model the same question and gets the same answer. Burning 2 more attempts
--   before dead-lettering only delays the outcome and spends 2 wasted calls.
--
--   permanent, request-wide (client_error with an auth/shape status: 400, 401,
--   403, 404, 422) — every other job under the same scoring_request will fail
--   identically, because the problem is the request's pinned model/schema or
--   the deployment's API key, not this post. Retrying job-by-job burns the
--   whole batch's attempts on a problem a human has to fix regardless.
--   Response: dead-letter this job immediately AND close the scoring_request,
--   so trg_enqueue_scoring_on_raw_post stops feeding it more work. Jobs
--   already in flight for this request still get read once and dead-letter
--   the same way — bounded, not free, but correct: nothing here bulk-edits
--   other jobs' state out from under a concurrent worker.
--
-- rate_limit / server_error / network / timeout keep the existing backoff
-- path (30s -> 120s -> dead-letter on the 3rd failure), unchanged.
create or replace function public.record_scoring_failure(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.scoring_job_state%rowtype;
  v_fc int;
  v_backoff int;
  v_permanent_job boolean;
  v_permanent_batch boolean;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;
  if v_job.status not in ('pending','processing') then
    raise exception 'job % not in a failable state (status=%)', p_job_id, v_job.status;
  end if;

  v_fc := v_job.failure_count + 1;
  update public.scoring_job_state
     set failure_count = v_fc, last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;

  -- refusal / content_filter: retrying asks the same question, gets the same
  -- answer. Dead-letter on first occurrence rather than accumulating 3.
  v_permanent_job := p_failure_type in ('refusal', 'content_filter');

  -- client_error carrying an auth/shape status: every job under this request
  -- fails the same way. Circuit-break the whole request, not just this job.
  v_permanent_batch := p_failure_type = 'client_error'
    and p_error_code in ('400', '401', '403', '404', '422');

  if v_permanent_job or v_permanent_batch then
    if v_permanent_batch then
      update public.scoring_requests set status = 'closed' where id = p_scoring_request_id and status <> 'closed';
    end if;
    perform public.dead_letter_scoring_job(
      p_job_id, p_msg_id, p_raw_post_id, p_scoring_request_id,
      p_failure_type, p_error_code, p_error_message, p_provider_response, v_fc);
    return 'dead_letter';
  end if;

  if v_fc >= 3 then
    perform public.dead_letter_scoring_job(
      p_job_id, p_msg_id, p_raw_post_id, p_scoring_request_id,
      'exhausted', p_error_code, coalesce(p_error_message, p_failure_type), p_provider_response, v_fc);
    return 'dead_letter';
  end if;

  v_backoff := case v_fc when 1 then 30 when 2 then 120 else 120 end;   -- server-authoritative
  update public.scoring_job_state
     set next_attempt_at = now() + make_interval(secs => v_backoff), status = 'pending', updated_at = now()
   where id = p_job_id;
  if p_msg_id is not null then perform pgmq.set_vt('scoring_jobs', p_msg_id, v_backoff); end if;
  return 'retry';
end
$$;

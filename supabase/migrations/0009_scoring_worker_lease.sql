-- =============================================================================
-- 0009_scoring_worker_lease.sql — Phase 3C blockers #1 + #2
-- =============================================================================
-- Atomic claim/lease + stale-worker rejection.
--
-- Before this, read_scoring_jobs (0006) only bumped pgmq's visibility timeout;
-- nothing recorded WHICH invocation owns a job. pgmq's VT is the primary claim,
-- but once a VT expires (a slow OpenAI call, a crashed worker) the message
-- becomes visible again and a second invocation can pick up the same job. The
-- idempotency_key already stops a duplicate scoring_results ROW, but a stale
-- worker's late record_scoring_failure would still RAISE ('not in a failable
-- state'), and that raise propagates out of the per-job loop and aborts the
-- whole batch.
--
-- Fix: a per-claim processing_token. read_scoring_jobs stamps a fresh token when
-- it claims a job; complete/record accept the token and, if it no longer matches
-- (a newer invocation has reclaimed the job), return 'superseded' benignly
-- instead of raising. Direct callers that never claimed (verify_scoring.sql,
-- offline tests) pass no token: a NULL job token vs a NULL argument matches, so
-- their behaviour is unchanged.
-- =============================================================================

-- 1. Lease columns -----------------------------------------------------------
alter table public.scoring_job_state
  add column processing_token uuid,
  add column leased_at        timestamptz;

-- 2. read_scoring_jobs becomes a CLAIM ---------------------------------------
-- Return type changes (adds processing_token), so it must be dropped first.
drop function if exists public.read_scoring_jobs(integer, integer);
create or replace function public.read_scoring_jobs(p_vt integer, p_qty integer)
returns table (msg_id bigint, message jsonb, processing_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; v_token uuid;
begin
  for r in select m.msg_id, m.message from pgmq.read('scoring_jobs', p_vt, p_qty) m loop
    v_token := gen_random_uuid();
    update public.scoring_job_state
       set processing_token = v_token, status = 'processing',
           leased_at = now(), msg_id = r.msg_id, updated_at = now()
     where id = (r.message ->> 'job_id')::uuid
       and status in ('pending', 'processing');
    if found then
      msg_id := r.msg_id; message := r.message; processing_token := v_token;
      return next;
    else
      -- Orphan message: the job row is gone or already terminal, so nothing
      -- downstream will ever complete it. Archive it rather than let it be
      -- re-read on every drain forever.
      perform pgmq.archive('scoring_jobs', r.msg_id);
    end if;
  end loop;
end
$$;
revoke all on function public.read_scoring_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.read_scoring_jobs(integer, integer) to service_role;

-- 3. complete_scoring_job — lease-aware --------------------------------------
-- Param count changes (adds p_processing_token), so drop the old signature.
drop function if exists public.complete_scoring_job(uuid, bigint, uuid, uuid, jsonb, text, jsonb);
create or replace function public.complete_scoring_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_theme_scores jsonb, p_reason text, p_provider_response jsonb default null,
  p_processing_token uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.scoring_job_state%rowtype;
  v_req public.scoring_requests%rowtype;
  v_overall numeric; v_included boolean; v_idk text; v_result_id uuid;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id        <> p_raw_post_id        then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id           then raise exception 'msg_id mismatch'; end if;

  -- Lease check: only the invocation that currently owns the job may complete
  -- it. A stale worker whose job was reclaimed returns benignly, never
  -- overwriting a newer result nor aborting the batch.
  if v_job.processing_token is distinct from p_processing_token then return 'superseded'; end if;

  if v_job.status = 'succeeded' then return 'duplicate'; end if;
  if v_job.status not in ('pending','processing') then return 'superseded'; end if;

  select * into v_req from public.scoring_requests where id = v_job.scoring_request_id for update;
  if not found then raise exception 'scoring_request % not found', v_job.scoring_request_id; end if;

  perform public.validate_theme_scores(p_theme_scores, v_req.config_snapshot);

  v_overall := public.scoring_apply_aggregation(v_req.aggregation_strategy, p_theme_scores);
  v_included := v_overall >= (v_req.config_snapshot ->> 'min_relevance_score')::numeric;

  v_idk := md5(concat_ws('|', p_raw_post_id::text, p_scoring_request_id::text,
                 v_req.config_hash, v_req.model_snapshot, v_req.prompt_version, v_req.aggregation_strategy));

  insert into public.scoring_results (
    raw_post_id, scoring_request_id, source, provenance_status, llm_used,
    model, model_snapshot, prompt_version, aggregation_strategy,
    theme_scores, overall_relevance, reason, included_in_generation,
    config_snapshot, config_hash, scoring_job_id, provider_response, idempotency_key
  ) values (
    p_raw_post_id, v_req.id, 'openai', 'llm_verified', true,
    v_req.model, v_req.model_snapshot, v_req.prompt_version, v_req.aggregation_strategy,
    p_theme_scores, v_overall, p_reason, v_included,
    v_req.config_snapshot, v_req.config_hash, p_job_id, p_provider_response, v_idk
  )
  on conflict (idempotency_key) do nothing
  returning id into v_result_id;

  update public.scoring_job_state set status = 'succeeded', updated_at = now() where id = p_job_id;
  if p_msg_id is not null then perform pgmq.archive('scoring_jobs', p_msg_id); end if;

  return case when v_result_id is null then 'duplicate' else 'inserted' end;
end
$$;

-- 4. record_scoring_failure — lease-aware (keeps 0008 disposition logic) ------
drop function if exists public.record_scoring_failure(uuid, bigint, uuid, uuid, text, text, text, jsonb);
create or replace function public.record_scoring_failure(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb default null,
  p_processing_token uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.scoring_job_state%rowtype;
  v_fc int; v_backoff int; v_permanent_job boolean; v_permanent_batch boolean;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;

  -- Lease check (see complete_scoring_job): a superseded worker's failure must
  -- not burn a retry or dead-letter a job a newer invocation now owns.
  if v_job.processing_token is distinct from p_processing_token then return 'superseded'; end if;
  if v_job.status not in ('pending','processing') then return 'superseded'; end if;

  v_fc := v_job.failure_count + 1;
  update public.scoring_job_state
     set failure_count = v_fc, last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;

  -- refusal / content_filter: retrying asks the same question, gets the same
  -- answer. Dead-letter on first occurrence.
  v_permanent_job := p_failure_type in ('refusal', 'content_filter');

  -- client_error with an auth/shape status: every job under this request fails
  -- the same way. Circuit-break the whole request.
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
  -- Release the lease: back to 'pending', token cleared so the next read claims
  -- a fresh one (and a direct null-token retry still matches).
  update public.scoring_job_state
     set next_attempt_at = now() + make_interval(secs => v_backoff), status = 'pending',
         processing_token = null, updated_at = now()
   where id = p_job_id;
  if p_msg_id is not null then perform pgmq.set_vt('scoring_jobs', p_msg_id, v_backoff); end if;
  return 'retry';
end
$$;

-- 5. Re-grant execute on the recreated functions (service_role only) ----------
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'complete_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid)',
    'record_scoring_failure(uuid,bigint,uuid,uuid,text,text,text,jsonb,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end
$grants$;

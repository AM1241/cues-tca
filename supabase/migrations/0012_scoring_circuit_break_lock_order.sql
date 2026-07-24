-- =============================================================================
-- 0012_scoring_circuit_break_lock_order.sql — fix a real deadlock in 0011
-- =============================================================================
-- 0011's own comment claimed the (job-row-first, then request-row, then
-- sibling-rows) lock order could not deadlock. That claim was WRONG and is
-- explicitly retracted here — do not resurrect it.
--
-- The actual deadlock (RETRACTED reasoning from 0011, corrected below)
-- -----------------------------------------------------------------------------
-- 0011 only analyzed the ASYMMETRIC case (one worker circuit-breaking, the
-- other merely wanting the request row for an unrelated reason) and wrongly
-- generalized "not a cycle" from that one case. The real, missed case is
-- SYMMETRIC: two jobs under the SAME request BOTH independently hit a
-- request-wide-permanent client_error at the same time (entirely realistic —
-- if the request-wide problem, e.g. a revoked key or a deleted model, causes
-- every job to fail identically, several jobs in-flight can all reach
-- record_scoring_failure's circuit-break branch concurrently). Then:
--   Worker A (job1's failure): holds job1-row (from `for update` at the top
--     of record_scoring_failure) -> wants scoring_requests-row -> (once
--     granted) wants job2-row, via cancel_scoring_request_siblings' bulk
--     UPDATE, to terminalize it as a sibling.
--   Worker B (job2's failure): holds job2-row (from ITS OWN top-of-function
--     `for update`) -> wants scoring_requests-row -> (once granted, which it
--     never will be) wants job1-row as A's sibling.
-- If A acquires scoring_requests first: A now blocks on job2 (held by B). B
-- is blocked on scoring_requests (held by A). A is waiting for something B
-- holds; B is waiting for something A holds. This IS a wait-for cycle —
-- textbook deadlock. Postgres's deadlock detector will eventually kill one
-- transaction, but "eventually recovers via abort" is not the same as "safe
-- lock order" — an aborted transaction here means the batch loop in
-- score-worker/index.ts sees a thrown error from what should have been a
-- normal RPC call, on a codepath that is specifically supposed to make
-- failures NON-fatal to the rest of the batch.
--
-- The fix: a single, unconditional, GLOBAL lock order — every function that
-- may touch both a scoring_requests row and a scoring_job_state row locks
-- scoring_requests FIRST, always, before locking any job row, with no
-- exception and no code path that reverses this even conditionally.
-- complete_scoring_job and record_scoring_failure are both replaced below to
-- lock via the CALLER-SUPPLIED p_scoring_request_id first (not the job's OWN
-- scoring_request_id column, which would require locking the job to read —
-- exactly the ordering this fixes), then lock the job row, then validate
-- that the job actually belongs to that request (unchanged validation logic,
-- just reordered after the request lock instead of before it).
--
-- Why this eliminates the cycle: EVERY transaction that could ever want both
-- a request row and a job row now acquires them in the identical order
-- (request, then job). Two transactions contending for the same two
-- resources in the same order can only ever block one on the other in a
-- straight line (A waits for B, or B waits for A) — never both simultaneously
-- waiting on each other, because whichever transaction acquires
-- scoring_requests first is guaranteed to attempt every job-row lock it
-- needs BEFORE the second transaction can even begin trying to acquire ITS
-- own job-row lock through this same code path (the second transaction is
-- already blocked on scoring_requests at that point, holding nothing else
-- this codepath would need). This is the standard "resource ordering"
-- deadlock-prevention strategy: a cycle in the wait-for graph is provably
-- impossible when every participant acquires a shared set of resources in
-- one fixed global order.
--
-- cancel_scoring_request_siblings itself is unchanged in this migration
-- (0011's ordering inside it — request first, then bulk sibling rows — was
-- already correct; the bug was entry points reaching it with the job row
-- already locked BEFORE the request row).
-- =============================================================================

-- 1. complete_scoring_job — request-first lock order ---------------------------
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
  -- Lock the REQUEST first, using the caller-supplied id — never the job's
  -- own scoring_request_id column, which would require locking the job first.
  select * into v_req from public.scoring_requests where id = p_scoring_request_id for update;
  if not found then raise exception 'scoring_request % not found', p_scoring_request_id; end if;

  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id        <> p_raw_post_id        then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id           then raise exception 'msg_id mismatch'; end if;

  -- Lease check: only the invocation that currently owns the job may complete
  -- it. A stale worker whose job was reclaimed (or cancelled by a sibling
  -- circuit-break, which now always happens under the request lock this
  -- function also holds by this point) returns benignly, never overwriting a
  -- newer result nor aborting the batch. Because we now hold the request
  -- lock BEFORE reading the job row, a concurrent circuit-break on the same
  -- request cannot interleave with this check: either the circuit-break's
  -- transaction committed before ours acquired the request lock (so
  -- v_job.processing_token is already null / status already dead_letter,
  -- and we correctly return 'superseded' below), or it has not started yet
  -- (so it will see our committed 'succeeded' status and its bulk UPDATE's
  -- `status in ('pending','processing')` filter will correctly skip this job).
  if v_job.processing_token is distinct from p_processing_token then return 'superseded'; end if;

  if v_job.status = 'succeeded' then return 'duplicate'; end if;
  if v_job.status not in ('pending','processing') then return 'superseded'; end if;

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
revoke all on function public.complete_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.complete_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid) to service_role;

-- 2. record_scoring_failure — request-first lock order, triggering job's
--    OWN lease also cleared on circuit-break -----------------------------------
create or replace function public.record_scoring_failure(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb default null,
  p_processing_token uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.scoring_job_state%rowtype;
  v_req public.scoring_requests%rowtype;
  v_fc int; v_backoff int; v_permanent_job boolean; v_permanent_batch boolean; v_sibling_count int;
begin
  -- Lock the REQUEST first (see 0012 header comment for why).
  select * into v_req from public.scoring_requests where id = p_scoring_request_id for update;
  if not found then raise exception 'scoring_request % not found', p_scoring_request_id; end if;

  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;

  -- Lease check (see complete_scoring_job): a superseded worker's failure must
  -- not burn a retry or dead-letter a job a newer invocation now owns.
  if v_job.processing_token is distinct from p_processing_token then return 'superseded'; end if;
  if v_job.status not in ('pending','processing') then return 'superseded'; end if;

  -- refusal / content_filter: retrying asks the same question, gets the same
  -- answer. Dead-letter on first occurrence. This IS a real (if singular)
  -- business attempt against THIS job, so failure_count is incremented.
  v_permanent_job := p_failure_type in ('refusal', 'content_filter');

  -- client_error carrying a request-wide config/auth/shape status: every job
  -- under this request fails the same way (404 = pinned model_snapshot not
  -- found, also request-wide since model_snapshot is immutable per request).
  -- This is NOT a business retry outcome for the triggering job — it is an
  -- infrastructure-level circuit-break — so failure_count is NOT incremented
  -- (distinguishing "a real provider call happened" [attempts=1 in
  -- scoring_dead_letter, always accurate] from "a business retry was
  -- consumed" [failure_count, left at its pre-call value for this
  -- disposition]).
  v_permanent_batch := p_failure_type = 'client_error'
    and p_error_code in ('400', '401', '403', '404', '422');

  if v_permanent_batch then
    -- Request-wide circuit-break: dead-letter the triggering job WITHOUT
    -- incrementing failure_count, ALSO clearing its own lease state (0012
    -- fix: 0011 left the triggering job's processing_token/leased_at/
    -- next_attempt_at untouched — only siblings got cleared. The triggering
    -- job is just as terminal as any sibling and must not retain a lease a
    -- stale worker could still reference).
    update public.scoring_job_state
       set last_failure_type = p_failure_type, last_error_code = p_error_code,
           last_error_message = p_error_message,
           processing_token = null, leased_at = null, next_attempt_at = null,
           updated_at = now()
     where id = p_job_id;

    perform public.dead_letter_scoring_job(
      p_job_id, p_msg_id, p_raw_post_id, p_scoring_request_id,
      p_failure_type, p_error_code, p_error_message, p_provider_response, 1);

    v_sibling_count := public.cancel_scoring_request_siblings(p_scoring_request_id, p_job_id, 'request_closed');
    return 'circuit_break';
  end if;

  v_fc := v_job.failure_count + 1;
  update public.scoring_job_state
     set failure_count = v_fc, last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;

  if v_permanent_job then
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
revoke all on function public.record_scoring_failure(uuid,bigint,uuid,uuid,text,text,text,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.record_scoring_failure(uuid,bigint,uuid,uuid,text,text,text,jsonb,uuid) to service_role;

-- 3. cancel_scoring_request_siblings — reduce exposure --------------------------
-- This helper is only ever called internally, from inside
-- record_scoring_failure (itself SECURITY DEFINER), which already holds the
-- scoring_requests lock this function re-acquires (a no-op re-lock within the
-- same transaction, not a wait). It has no reason to be directly callable —
-- an Edge Function or any other caller invoking it directly would bypass
-- record_scoring_failure's own validation (mismatch checks, lease check,
-- disposition logic) entirely. Revoke execute from every role including
-- service_role; only the owning role (whoever ran this migration, typically
-- postgres/supabase_admin) can invoke it, which is sufficient for one
-- SECURITY DEFINER function calling another — SECURITY DEFINER functions
-- execute with the privileges of their OWNER, not the calling role, so
-- record_scoring_failure (owned by the same migration-running role) can
-- still call cancel_scoring_request_siblings without an explicit grant.
revoke all on function public.cancel_scoring_request_siblings(uuid, uuid, text) from public, anon, authenticated, service_role;

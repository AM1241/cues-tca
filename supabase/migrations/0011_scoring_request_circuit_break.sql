-- =============================================================================
-- 0011_scoring_request_circuit_break.sql — Phase 3C: request-wide circuit-break
-- =============================================================================
-- Confirmed gap (phase3c-reconciliation audit): closing a scoring_requests row
-- (0008/0009's "circuit-break" on a permanent, request-wide client_error) only
-- ever stopped NEW jobs from being enqueued (enqueue_scoring_job already
-- checked status='active'). It did nothing to jobs that were already
-- 'pending' or 'processing' under that request at the moment it closed —
-- those remained fully claimable by read_scoring_jobs and would still reach
-- OpenAI, spending more real calls on a request already known to be broken
-- (wrong model, revoked key, malformed schema — whatever caused the
-- 400/401/403/404/422 in the first place).
--
-- Design choice — reuse dead_letter, not a new job status
-- -----------------------------------------------------------------------------
-- scoring_job_state.status stays {'pending','processing','succeeded',
-- 'dead_letter'} (no new value, no CHECK-constraint widening). A
-- request-cancelled job is dead_letter with last_failure_type/failure_type =
-- 'request_closed'. Nothing about "dead_letter" in this schema means
-- "OpenAI failed" specifically — it already means "terminal, no more
-- retries, a human/operator should look at it" (see 0005's original
-- 3-strikes 'exhausted' path, and 0008's immediate refusal/content_filter
-- path) — request_closed is one more reason in that same family, not a
-- different kind of terminal state. A new 'cancelled' status would require
-- widening the CHECK constraint and teaching every downstream consumer
-- (frontend Review/traceability views, this file's own later sections,
-- any future dashboard) about a fifth status for no behavioral benefit:
-- nothing needs to distinguish "cancelled" from "dead_letter" at the SQL or
-- RLS level, only failure_type distinguishes WHY a job is terminal, which
-- scoring_dead_letter.failure_type already exists to carry.
--
-- Concurrency / lock-ordering reasoning
-- -----------------------------------------------------------------------------
-- The unchanged entry points (complete_scoring_job, record_scoring_failure)
-- both start with `select ... from scoring_job_state where id = p_job_id for
-- update` — they lock their OWN job row first, before touching anything else.
-- That ordering is preserved unchanged here. The new bulk-cancellation
-- function, cancel_scoring_request_siblings, is only ever called AFTER that
-- per-job lock is already held, and it:
--   1. locks scoring_requests first (`for update`) — closing the request and
--      acquiring the row lock in the same step,
--   2. then bulk-locks every sibling job row via ONE set-based
--      `UPDATE ... WHERE scoring_request_id = ... AND status IN (...)`
--      statement (not a per-row loop with separate SELECT ... FOR UPDATE
--      calls), which Postgres resolves by normal blocking against another
--      concurrent transaction doing the same scan — not deadlock, because
--      neither transaction is a per-row loop that could interleave lock
--      acquisition with the other transaction's held locks.
-- Two concurrent failures on two different jobs under the SAME request:
--   worker A (job1): holds job1-row lock (from top of record_scoring_failure)
--     -> wants scoring_requests-row -> (once granted) wants job2-row via the
--     bulk UPDATE.
--   worker B (job2): holds job2-row lock -> wants scoring_requests-row.
-- This is NOT a cycle: job2's transaction never waits on job1's row. Worker A
-- either wins the scoring_requests lock first (worker B then blocks on
-- scoring_requests, and once worker A's bulk UPDATE reaches job2's row it
-- will itself block briefly behind worker B's held job2 lock until worker B's
-- transaction ends — but worker B is NOT waiting on anything worker A holds
-- alone, since worker B only wants scoring_requests, which worker A will
-- release at commit) — so this resolves via ordinary lock waiting, never a
-- wait-for cycle. The excluded raw_post_id/job_id already locked by the
-- calling function is included in the bulk UPDATE's WHERE clause with no
-- special-casing needed: re-locking a row your OWN transaction already holds
-- is a no-op in Postgres, not a self-deadlock.
--
-- Idempotency
-- -----------------------------------------------------------------------------
-- cancel_scoring_request_siblings only touches rows with
-- status IN ('pending','processing') — a second call (or a call after the
-- request is already fully cancelled) matches zero rows and is a safe no-op.
-- scoring_dead_letter inserts go through the existing
-- `on conflict (job_id) do update` pattern from dead_letter_scoring_job,
-- so re-running never creates a duplicate row.
-- =============================================================================

-- 1. Bulk sibling cancellation -------------------------------------------------
-- Called AFTER the caller already holds a `for update` lock on its own job
-- row and has determined the failure is request-wide-permanent. Locks
-- scoring_requests first, closes it, then terminalizes every OTHER
-- pending/processing job under it in one set-based statement. Returns the
-- count of siblings actually cancelled (for logging/assertions), not
-- including the triggering job itself (the caller dead-letters that one via
-- the existing dead_letter_scoring_job path, unchanged).
create or replace function public.cancel_scoring_request_siblings(
  p_scoring_request_id uuid, p_triggering_job_id uuid, p_reason text default 'request_closed'
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  r record;
begin
  -- Lock + close the request first (see concurrency note above). Idempotent:
  -- a request already closed is simply left closed, no error.
  perform 1 from public.scoring_requests where id = p_scoring_request_id for update;
  update public.scoring_requests set status = 'closed'
   where id = p_scoring_request_id and status <> 'closed';

  -- Bulk-lock and terminalize every OTHER non-terminal sibling in one
  -- statement. Excludes the triggering job (the caller's own
  -- dead_letter_scoring_job call handles that one, with its own
  -- attempts/error detail already computed).
  for r in
    update public.scoring_job_state
       set status = 'dead_letter',
           last_failure_type = p_reason,
           last_error_code = null,
           last_error_message = 'sibling job under a request-wide circuit-break',
           processing_token = null,
           leased_at = null,
           next_attempt_at = null,
           updated_at = now()
     where scoring_request_id = p_scoring_request_id
       and status in ('pending', 'processing')
       and id <> p_triggering_job_id
    returning id, raw_post_id, msg_id, failure_count
  loop
    v_count := v_count + 1;

    insert into public.scoring_dead_letter (
      job_id, raw_post_id, scoring_request_id, failure_type, error_code, error_message, provider_response, attempts
    ) values (
      r.id, r.raw_post_id, p_scoring_request_id, p_reason, null,
      'sibling job under a request-wide circuit-break', null, r.failure_count
    )
    on conflict (job_id) do update
      set failure_type = excluded.failure_type, error_message = excluded.error_message,
          attempts = excluded.attempts, dead_lettered_at = now();

    if r.msg_id is not null then perform pgmq.archive('scoring_jobs', r.msg_id); end if;
  end loop;

  return v_count;
end
$$;
revoke all on function public.cancel_scoring_request_siblings(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_scoring_request_siblings(uuid, uuid, text) to service_role;

-- 2. record_scoring_failure — invoke sibling cancellation on a request-wide
--    permanent failure, and stop double-counting business failure_count for
--    that exact case ---------------------------------------------------------
-- Signature is unchanged from 0009 (no new params), so a plain CREATE OR
-- REPLACE is valid here — no drop/param-count change.
--
-- 404 decision: OpenAI's /v1/responses 404 means "model not found" for the
-- pinned model_snapshot (see _shared/openai.ts — a bare `res.status >= 400`
-- -> 'client_error' with the numeric status as p_error_code). model_snapshot
-- is immutable per scoring_requests (0005) and identical for every job under
-- the same request, so a 404 on one job's model will 404 for every sibling
-- too — a request-wide configuration defect (a pinned model that no longer
-- exists / was deprecated / mistyped), not a per-post problem. It is grouped
-- with 400/401/403/422, not with the transient retry path. Documented here
-- and asserted in scripts/verify_scoring.sql and the Deno suite — not a
-- silent inclusion.
create or replace function public.record_scoring_failure(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb default null,
  p_processing_token uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.scoring_job_state%rowtype;
  v_fc int; v_backoff int; v_permanent_job boolean; v_permanent_batch boolean; v_sibling_count int;
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

  -- refusal / content_filter: retrying asks the same question, gets the same
  -- answer. Dead-letter on first occurrence. This IS a real (if singular)
  -- business attempt against THIS job, so failure_count is incremented.
  v_permanent_job := p_failure_type in ('refusal', 'content_filter');

  -- client_error carrying a request-wide config/auth/shape status: every job
  -- under this request fails the same way (see 404 note above for why 404 is
  -- included). This is NOT a business retry outcome for the triggering job —
  -- it is an infrastructure-level circuit-break — so failure_count is NOT
  -- incremented for it (distinguishing "a real provider call happened"
  -- [attempts=1 in scoring_dead_letter, always accurate] from "a business
  -- retry was consumed" [failure_count, now left at its pre-call value for
  -- this specific disposition]).
  v_permanent_batch := p_failure_type = 'client_error'
    and p_error_code in ('400', '401', '403', '404', '422');

  if v_permanent_batch then
    -- Request-wide circuit-break: dead-letter the triggering job WITHOUT
    -- incrementing failure_count, cancel every sibling, close the request.
    update public.scoring_job_state
       set last_failure_type = p_failure_type, last_error_code = p_error_code,
           last_error_message = p_error_message, updated_at = now()
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

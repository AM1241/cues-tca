-- =============================================================================
-- 0013_scoring_enqueue_lock_order.sql — enqueue_scoring_job locks the request
-- =============================================================================
-- enqueue_scoring_job (0005) reads scoring_requests.status with a plain
-- SELECT (no FOR UPDATE) before deciding whether to insert a job. That is a
-- genuine race against the request-first lock order 0012 established for
-- complete_scoring_job / record_scoring_failure: a concurrent circuit-break
-- (record_scoring_failure's permanent-batch branch, which now locks
-- scoring_requests FOR UPDATE before touching anything else) could commit
-- between enqueue_scoring_job's unlocked read and its INSERT, closing the
-- request status='closed' after enqueue_scoring_job already decided
-- status='active' was true — creating a new job under a request that is (or
-- is about to be) closed, which cancel_scoring_request_siblings would then
-- never see, because the sibling-cancellation loop already ran before this
-- late job existed.
--
-- Fix: enqueue_scoring_job now locks scoring_requests FOR UPDATE first, same
-- as complete_scoring_job/record_scoring_failure — completing the SAME
-- global lock order 0012 established, extended to the third and last entry
-- point that touches both a request row and job rows.
--
-- Two serialized outcomes are now the only possible outcomes for a race
-- between an enqueue and a circuit-break on the same request:
--   enqueue wins the request lock first: it observes status='active'
--     (the circuit-break has not committed 'closed' yet), inserts the job
--     and pgmq message normally, then releases the lock. The circuit-break,
--     which was blocked on the SAME lock, then proceeds and its
--     cancel_scoring_request_siblings bulk UPDATE — which runs AFTER
--     enqueue's job row is already committed and visible — correctly finds
--     and terminalizes it as a sibling. No job is left pending/processing
--     under a closed request.
--   circuit-break wins the request lock first: it closes the request and
--     cancels every CURRENTLY EXISTING sibling, then releases the lock.
--     enqueue, which was blocked on the SAME lock, then proceeds, reads
--     status='closed', and raises — exactly its existing (unchanged)
--     behavior for a not-active request. No job is ever created.
-- Neither outcome can create a job that outlives the circuit-break as
-- pending/processing, because both paths now serialize through the same
-- single lock rather than racing two independent unlocked reads.
--
-- Idempotency (unchanged): `on conflict (raw_post_id, scoring_request_id) do
-- nothing` already made a duplicate enqueue call for the same logical job a
-- no-op; that behavior is untouched by this migration.
-- =============================================================================
create or replace function public.enqueue_scoring_job(p_raw_post_id uuid, p_scoring_request_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_job_id uuid; v_msg_id bigint;
begin
  select status into v_status from public.scoring_requests where id = p_scoring_request_id for update;
  if not found then raise exception 'scoring_request % not found', p_scoring_request_id; end if;
  if v_status <> 'active' then raise exception 'scoring_request % is not active (status=%)', p_scoring_request_id, v_status; end if;

  insert into public.scoring_job_state (raw_post_id, scoring_request_id, status)
  values (p_raw_post_id, p_scoring_request_id, 'pending')
  on conflict (raw_post_id, scoring_request_id) do nothing
  returning id into v_job_id;

  if v_job_id is null then return null; end if;

  v_msg_id := pgmq.send('scoring_jobs', jsonb_build_object(
    'job_id', v_job_id, 'raw_post_id', p_raw_post_id, 'scoring_request_id', p_scoring_request_id));
  update public.scoring_job_state set msg_id = v_msg_id, updated_at = now() where id = v_job_id;
  return v_job_id;
end
$$;
revoke all on function public.enqueue_scoring_job(uuid,uuid) from public, anon, authenticated;
grant execute on function public.enqueue_scoring_job(uuid,uuid) to service_role;

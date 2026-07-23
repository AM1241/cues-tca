-- =============================================================================
-- 0006_scoring_worker.sql — Phase 3C: PostgREST access to the scoring_jobs queue
-- =============================================================================
--
-- pgmq lives in the `pgmq` schema. `service_role` already has full USAGE +
-- EXECUTE + table DML on it (granted in 0005), but PostgREST only exposes
-- `public` and `graphql_public` (see supabase/config.toml) — an Edge Function
-- using the supabase-js REST client cannot call `pgmq.read` directly.
--
-- This adds one `public`, SECURITY DEFINER wrapper so score-worker can drain
-- the queue over PostgREST like every other RPC it calls. No other schema
-- change; 0001–0005 are untouched.
-- =============================================================================

create or replace function public.read_scoring_jobs(p_vt integer, p_qty integer)
returns table (msg_id bigint, message jsonb)
language sql security definer set search_path = '' as $$
  select msg_id, message from pgmq.read('scoring_jobs', p_vt, p_qty)
$$;

revoke all on function public.read_scoring_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.read_scoring_jobs(integer, integer) to service_role;

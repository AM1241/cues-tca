-- 0007_source_last_fetched.sql
-- Stamp sources.last_fetched_at when a source is successfully collected.
--
-- The `ingest` function records everything in the ingest_runs observability
-- tables but never touches the sources row, so sources.last_fetched_at was
-- always null and the UI showed "never" even after a real collection.
--
-- "Last fetched" means "last time we successfully pulled posts": stamp only
-- when a per-source run row reaches status = 'ok'. failed / rate_limited /
-- auth_failed / skipped leave it unchanged, so the timestamp never lies about
-- a run that did not actually succeed.

-- -----------------------------------------------------------------------------
-- stamp_source_last_fetched — set sources.last_fetched_at on a successful fetch
-- -----------------------------------------------------------------------------
-- Fires when a per-source row transitions into 'ok' (INSERT straight to 'ok',
-- or UPDATE from 'running' to 'ok'). ingest_run_sources.finished_at is the
-- moment the source finished; use it so the timestamp matches the run, not the
-- trigger firing. Guard on the transition so re-touching an already-ok row is a
-- no-op and never moves the timestamp backwards.
create or replace function public.stamp_source_last_fetched()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'ok'
     and (tg_op = 'INSERT' or old.status is distinct from 'ok') then
    update public.sources
       set last_fetched_at = coalesce(new.finished_at, now())
     where id = new.source_id
       and (last_fetched_at is null
            or last_fetched_at < coalesce(new.finished_at, now()));
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_source_last_fetched()
  from public, anon, authenticated;

create trigger trg_stamp_source_last_fetched
  after insert or update of status on public.ingest_run_sources
  for each row
  execute function public.stamp_source_last_fetched();

-- -----------------------------------------------------------------------------
-- Backfill: the 4 sources have been collected before this migration existed, so
-- seed last_fetched_at from the newest successful per-source run already on
-- record. Sources never successfully fetched stay null ("never"), correctly.
-- -----------------------------------------------------------------------------
update public.sources s
   set last_fetched_at = latest.finished_at
  from (
    select source_id, max(finished_at) as finished_at
      from public.ingest_run_sources
     where status = 'ok'
       and finished_at is not null
     group by source_id
  ) latest
 where latest.source_id = s.id
   and (s.last_fetched_at is null or s.last_fetched_at < latest.finished_at);

-- =============================================================================
-- 0003_ingest.sql — ingest observability, concurrency control, content changes
-- =============================================================================
--
-- Phase 2 support. Nothing here calls the provider; this is the schema the
-- `ingest` Edge Function writes to.
--
-- 0001 and 0002 are applied to the cloud project and are never edited again.
-- Everything below is additive.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- raw_posts.last_seen_at
-- -----------------------------------------------------------------------------
-- Added in four steps so this is safe against a populated table: nullable,
-- backfill, default, then NOT NULL. collected_at keeps its meaning (first
-- sighting) and gains a counterpart for the most recent one.
-- -----------------------------------------------------------------------------
alter table public.raw_posts add column last_seen_at timestamptz;

update public.raw_posts set last_seen_at = collected_at where last_seen_at is null;

alter table public.raw_posts alter column last_seen_at set default now();
alter table public.raw_posts alter column last_seen_at set not null;

comment on column public.raw_posts.collected_at is
  'First time ingest stored this post. Never updated.';
comment on column public.raw_posts.last_seen_at is
  'Most recent run in which the provider still returned this post. Refreshed on every '
  'sighting, including sightings whose text differs from what is stored.';


-- -----------------------------------------------------------------------------
-- ingest_runs
-- -----------------------------------------------------------------------------
create table public.ingest_runs (
  id                     uuid primary key default gen_random_uuid(),

  -- Derived from the caller's authentication context, never from the request
  -- body. An end-user invocation is always 'manual'; only a service-role caller
  -- may claim 'cron' or 'backfill'. See functions/ingest/index.ts.
  trigger_source         text not null check (trigger_source in ('manual','cron','backfill')),

  -- ON DELETE SET NULL, and deliberately NO constraint requiring a user for
  -- manual runs: deleting an editor from auth.users must not retroactively
  -- invalidate their historical runs. The requirement is enforced at request
  -- time in the Edge Function. The snapshot below keeps the history readable
  -- after the user is gone.
  triggered_by           uuid references auth.users (id) on delete set null,
  triggered_by_email     text,

  status                 text not null default 'running'
                           check (status in ('running','completed','completed_with_errors','failed')),
  dry_run                boolean not null default false,
  requested_source_ids   jsonb not null default '[]'::jsonb,
  lookback_days_override integer check (lookback_days_override between 1 and 90),

  -- Outbound HTTP attempts, retries and error responses included. This is our
  -- own instrumentation, NOT an authoritative billing figure: the provider may
  -- price per credit, per result, or not charge for some error classes. The
  -- RapidAPI dashboard remains the source of truth for quota. This number
  -- exists to correlate against it and to bound our own behaviour.
  provider_requests      integer not null default 0 check (provider_requests >= 0),
  -- Pages actually received across all sources. Always <= provider_requests.
  pages_fetched          integer not null default 0 check (pages_fetched >= 0),

  sources_total          integer not null default 0,
  sources_ok             integer not null default 0,
  sources_failed         integer not null default 0,
  sources_skipped        integer not null default 0,

  posts_fetched               integer not null default 0,
  posts_inserted              integer not null default 0,
  posts_metadata_refreshed    integer not null default 0,
  posts_content_changed       integer not null default 0,
  posts_skipped_duplicate     integer not null default 0,
  -- No usable provider id: cannot be deduplicated, so never stored.
  posts_skipped_no_id         integer not null default 0,
  -- Had an id, but no text or no parseable published_at. Kept separate from
  -- no_id because they point at different provider problems.
  posts_skipped_malformed     integer not null default 0,
  posts_skipped_out_of_window integer not null default 0,

  error                  text,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,

  constraint ingest_runs_finish_after_start
    check (finished_at is null or finished_at >= started_at),
  -- Both directions: a running row has no finish time, a terminal row must have
  -- one. Rules out both "running since yesterday, finished at noon" and
  -- "completed, still open".
  constraint ingest_runs_status_finish_consistent check (
    (status = 'running'  and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  )
);

create index ingest_runs_started_idx on public.ingest_runs (started_at desc);
create index ingest_runs_active_idx  on public.ingest_runs (started_at) where status = 'running';

comment on column public.ingest_runs.provider_requests is
  'Outbound HTTP attempts including retries and error responses. Instrumentation, not billing. '
  'The RapidAPI dashboard is authoritative for quota.';
comment on column public.ingest_runs.triggered_by_email is
  'Actor snapshot. Survives deletion of the auth.users row.';


-- -----------------------------------------------------------------------------
-- ingest_run_sources — per-source results, and the concurrency guard
-- -----------------------------------------------------------------------------
create table public.ingest_run_sources (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references public.ingest_runs (id) on delete cascade,
  -- RESTRICT so run history cannot be silently orphaned. The snapshots below
  -- keep the row readable if the source is later renamed or repointed.
  source_id           uuid not null references public.sources (id) on delete restrict,
  source_name         text not null,
  rapidapi_identifier text,

  status              text not null default 'running'
                        check (status in ('running','ok','failed','rate_limited','auth_failed','skipped')),
  -- 'auth_aborted' is recorded for sources that were never attempted because an
  -- earlier source failed provider authentication. They are not "fine", they
  -- are unexplained gaps unless we say so.
  error_code          text check (error_code in (
                        'disabled','no_rapidapi_identifier','locked','stale_lock',
                        'auth','auth_aborted','rate_limit','server_error','network',
                        'malformed_response','timeout','budget_exhausted')),

  pages_fetched       integer not null default 0 check (pages_fetched >= 0),
  provider_requests   integer not null default 0 check (provider_requests >= 0),
  truncated           boolean not null default false,

  posts_fetched               integer not null default 0,
  posts_inserted              integer not null default 0,
  posts_metadata_refreshed    integer not null default 0,
  posts_content_changed       integer not null default 0,
  posts_skipped_duplicate     integer not null default 0,
  posts_skipped_no_id         integer not null default 0,
  posts_skipped_malformed     integer not null default 0,
  posts_skipped_out_of_window integer not null default 0,

  http_status         integer,
  error_message       text,
  retry_after_seconds integer,

  started_at          timestamptz not null default now(),
  finished_at         timestamptz,

  constraint ingest_run_sources_uniq unique (run_id, source_id),
  constraint ingest_run_sources_finish_after_start
    check (finished_at is null or finished_at >= started_at),
  constraint ingest_run_sources_status_finish_consistent check (
    (status = 'running'  and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  ),
  -- Attempts can never be fewer than successes.
  constraint ingest_run_sources_requests_ge_pages
    check (provider_requests >= pages_fetched)
);

-- CONCURRENCY GUARD. One active claim per source, enforced by the database
-- rather than by hoping two callers never overlap. Cron firing while an editor
-- presses "Collect now" loses the race here and records error_code = 'locked'
-- instead of spending a second set of provider quota on the same posts.
create unique index ingest_run_sources_one_active_per_source
  on public.ingest_run_sources (source_id) where status = 'running';

create index ingest_run_sources_run_idx    on public.ingest_run_sources (run_id);
create index ingest_run_sources_source_idx on public.ingest_run_sources (source_id, started_at desc);

comment on column public.ingest_run_sources.provider_requests is
  'Every outbound HTTP attempt for this source, retries and error responses included. '
  'Two failures then one good page = provider_requests 3, pages_fetched 1.';
comment on column public.ingest_run_sources.rapidapi_identifier is
  'Snapshot of the exact linkedin_url sent to the provider. Without it a failed run cannot be diagnosed.';


-- -----------------------------------------------------------------------------
-- raw_post_content_changes
-- -----------------------------------------------------------------------------
-- Ingest never rewrites stored post text: normalized_posts, analyzed_posts and
-- anonymized_posts_current are all derived from it, and silently swapping the
-- text underneath them would leave scores and anonymisations describing copy
-- that no longer exists. The observed version is parked here instead, with its
-- text, so applying it later costs no additional provider quota.
-- -----------------------------------------------------------------------------
create table public.raw_post_content_changes (
  id                    uuid primary key default gen_random_uuid(),
  raw_post_id           uuid not null references public.raw_posts (id) on delete cascade,
  run_id                uuid references public.ingest_runs (id) on delete set null,

  stored_content_hash   text not null,
  observed_content_hash text not null,
  observed_post_text    text not null,

  observation_count     integer not null default 1 check (observation_count > 0),
  first_observed_at     timestamptz not null default now(),
  last_observed_at      timestamptz not null default now(),

  resolved_at           timestamptz,
  resolution            text check (resolution in ('applied','dismissed')),

  constraint content_changes_hashes_differ
    check (observed_content_hash <> stored_content_hash),
  constraint content_changes_resolution_consistent check (
    (resolved_at is null     and resolution is null)
    or (resolved_at is not null and resolution is not null)
  )
);

-- One OPEN record per (post, observed version). Ingest upserts onto this, so a
-- post whose text changed once does not accrue a row per nightly run. Partial on
-- resolved_at, so a version that was dismissed and later reappears opens afresh
-- rather than colliding with the closed record.
create unique index raw_post_content_changes_open_uniq
  on public.raw_post_content_changes (raw_post_id, observed_content_hash)
  where resolved_at is null;

create index raw_post_content_changes_open_idx
  on public.raw_post_content_changes (last_observed_at desc) where resolved_at is null;

comment on table public.raw_post_content_changes is
  'Observed-but-not-applied post text. Applying one is a deliberate future operation that must '
  'also mark downstream normalized/analyzed/anonymized rows for reprocessing.';


-- -----------------------------------------------------------------------------
-- record_content_change — compare observed text against stored, dedup the record
-- -----------------------------------------------------------------------------
-- Lives in SQL because raw_posts.content_hash is `generated always as
-- (md5(post_text))`: the comparison belongs where that definition is, and the
-- deduplicating insert needs the partial unique index predicate, which
-- PostgREST's on_conflict cannot express.
--
-- Returns true when a change was recorded, false when the text is unchanged.
-- Never modifies raw_posts.
-- -----------------------------------------------------------------------------
create or replace function public.record_content_change(
  p_raw_post_id   uuid,
  p_run_id        uuid,
  p_observed_text text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stored   text;
  v_observed text := md5(p_observed_text);
begin
  select content_hash into v_stored from public.raw_posts where id = p_raw_post_id;
  if v_stored is null then
    raise exception 'raw_post % not found', p_raw_post_id;
  end if;

  if v_stored = v_observed then
    return false;
  end if;

  insert into public.raw_post_content_changes as c
    (raw_post_id, run_id, stored_content_hash, observed_content_hash, observed_post_text)
  values (p_raw_post_id, p_run_id, v_stored, v_observed, p_observed_text)
  on conflict (raw_post_id, observed_content_hash) where resolved_at is null
  do update set last_observed_at  = now(),
                observation_count = c.observation_count + 1,
                run_id            = excluded.run_id;

  return true;
end;
$$;

revoke all on function public.record_content_change(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_content_change(uuid, uuid, text) to service_role;


-- -----------------------------------------------------------------------------
-- claim_source_for_ingest — take the per-source lock, reaping stale claims
-- -----------------------------------------------------------------------------
create or replace function public.claim_source_for_ingest(
  p_run_id      uuid,
  p_source_id   uuid,
  p_source_name text,
  p_identifier  text,
  p_stale_after interval default '15 minutes'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A crashed function leaves status = 'running' forever and would lock the
  -- source out permanently. Reap abandoned claims before contending.
  update public.ingest_run_sources
     set status        = 'failed',
         error_code    = 'stale_lock',
         error_message = 'Run abandoned; claim reaped.',
         finished_at   = now()
   where source_id = p_source_id
     and status    = 'running'
     and started_at < now() - p_stale_after;

  insert into public.ingest_run_sources (run_id, source_id, source_name, rapidapi_identifier, status)
  values (p_run_id, p_source_id, p_source_name, p_identifier, 'running');

  return true;
exception
  when unique_violation then
    return false;   -- another run holds this source
end;
$$;

revoke all on function public.claim_source_for_ingest(uuid, uuid, text, text, interval)
  from public, anon, authenticated;
grant execute on function public.claim_source_for_ingest(uuid, uuid, text, text, interval)
  to service_role;


-- -----------------------------------------------------------------------------
-- finalize_ingest_run — close a run and recompute its totals from its children
-- -----------------------------------------------------------------------------
-- Totals are derived, never accumulated in the function, so a crashed or
-- partially-reaped run still reports numbers that match its source rows.
-- -----------------------------------------------------------------------------
create or replace function public.finalize_ingest_run(p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_running int;
  v_status  text;
  v_ok int; v_failed int; v_skipped int; v_total int;
begin
  select count(*) into v_running
    from public.ingest_run_sources
   where run_id = p_run_id and status = 'running';

  if v_running > 0 then
    return null;              -- still working; nothing to finalize
  end if;

  -- OPERATIONAL FAILURES. A source the caller asked for and did not get is a
  -- failure, however politely it was skipped:
  --
  --   budget_exhausted      we ran out of time
  --   locked                another run held it; this run collected nothing
  --   no_rapidapi_identifier  configured but unusable
  --   auth_aborted          never attempted because the provider key is bad
  --
  -- Only 'disabled' is a benign skip: an operator switched it off, so not
  -- collecting it is the correct outcome rather than a shortfall.
  --
  -- Without this, a run in which every source was locked would report
  -- 'completed' having collected nothing at all — the most misleading state
  -- this table can hold.
  select count(*),
         count(*) filter (where status = 'ok'),
         count(*) filter (
           where status in ('failed','auth_failed','rate_limited')
              or (status = 'skipped' and error_code in (
                    'budget_exhausted','locked','no_rapidapi_identifier','auth_aborted'))),
         count(*) filter (
           where status = 'skipped'
             and coalesce(error_code,'') not in (
                   'budget_exhausted','locked','no_rapidapi_identifier','auth_aborted'))
    into v_total, v_ok, v_failed, v_skipped
    from public.ingest_run_sources
   where run_id = p_run_id;

  -- No source rows at all means the invocation died before it recorded even a
  -- skip. index.ts rejects an empty source list with 400 before creating a run,
  -- so this state is only ever reached by a crash. Reporting it as 'completed'
  -- would describe a crashed run as a clean one.
  v_status := case
                when v_total = 0               then 'failed'
                when v_failed > 0 and v_ok = 0 then 'failed'
                when v_failed > 0              then 'completed_with_errors'
                else 'completed'
              end;

  update public.ingest_runs r
     set status          = v_status,
         finished_at     = coalesce(r.finished_at, now()),
         error           = case
                             when v_total = 0
                               then coalesce(r.error, 'Run abandoned; no source claims recorded.')
                             else r.error
                           end,
         sources_total   = v_total,
         sources_ok      = v_ok,
         sources_failed  = v_failed,
         sources_skipped = v_skipped,
         provider_requests           = coalesce(s.provider_requests, 0),
         pages_fetched               = coalesce(s.pages_fetched, 0),
         posts_fetched               = coalesce(s.posts_fetched, 0),
         posts_inserted              = coalesce(s.posts_inserted, 0),
         posts_metadata_refreshed    = coalesce(s.posts_metadata_refreshed, 0),
         posts_content_changed       = coalesce(s.posts_content_changed, 0),
         posts_skipped_duplicate     = coalesce(s.posts_skipped_duplicate, 0),
         posts_skipped_no_id         = coalesce(s.posts_skipped_no_id, 0),
         posts_skipped_malformed     = coalesce(s.posts_skipped_malformed, 0),
         posts_skipped_out_of_window = coalesce(s.posts_skipped_out_of_window, 0)
    from (
      select sum(provider_requests)           as provider_requests,
             sum(pages_fetched)               as pages_fetched,
             sum(posts_fetched)               as posts_fetched,
             sum(posts_inserted)              as posts_inserted,
             sum(posts_metadata_refreshed)    as posts_metadata_refreshed,
             sum(posts_content_changed)       as posts_content_changed,
             sum(posts_skipped_duplicate)     as posts_skipped_duplicate,
             sum(posts_skipped_no_id)         as posts_skipped_no_id,
             sum(posts_skipped_malformed)     as posts_skipped_malformed,
             sum(posts_skipped_out_of_window) as posts_skipped_out_of_window
        from public.ingest_run_sources where run_id = p_run_id
    ) s
   where r.id = p_run_id and r.status = 'running';

  return v_status;
end;
$$;

revoke all on function public.finalize_ingest_run(uuid) from public, anon, authenticated;
grant execute on function public.finalize_ingest_run(uuid) to service_role;


-- -----------------------------------------------------------------------------
-- reap_stale_ingest — recover everything a crashed invocation left behind
-- -----------------------------------------------------------------------------
-- An Edge Function killed mid-run leaves a stale source claim AND a parent run
-- stuck at 'running'. claim_source_for_ingest only reaps the source it wants;
-- this sweeps both, and is safe to call at the start of every run.
-- -----------------------------------------------------------------------------
create or replace function public.reap_stale_ingest(p_stale_after interval default '15 minutes')
returns table (reaped_sources int, finalized_runs int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sources int := 0;
  v_runs    int := 0;
  r         record;
begin
  with reaped as (
    update public.ingest_run_sources
       set status        = 'failed',
           error_code    = 'stale_lock',
           error_message = 'Run abandoned; claim reaped.',
           finished_at   = now()
     where status = 'running'
       and started_at < now() - p_stale_after
    returning 1
  )
  select count(*) into v_sources from reaped;

  for r in
    select id from public.ingest_runs
     where status = 'running' and started_at < now() - p_stale_after
  loop
    if public.finalize_ingest_run(r.id) is not null then
      v_runs := v_runs + 1;
    else
      -- No source rows at all (crashed before claiming anything).
      update public.ingest_runs
         set status = 'failed', finished_at = now(),
             error = coalesce(error, 'Run abandoned; no source claims recorded.')
       where id = r.id and status = 'running';
      v_runs := v_runs + 1;
    end if;
  end loop;

  reaped_sources := v_sources;
  finalized_runs := v_runs;
  return next;
end;
$$;

revoke all on function public.reap_stale_ingest(interval) from public, anon, authenticated;
grant execute on function public.reap_stale_ingest(interval) to service_role;


-- -----------------------------------------------------------------------------
-- Privileges — explicit, nothing inherited
-- -----------------------------------------------------------------------------
-- 0002 set default privileges, but this migration does not depend on them
-- having reached these tables. Revoke first, then grant precisely.
-- -----------------------------------------------------------------------------
alter table public.ingest_runs              enable row level security;
alter table public.ingest_run_sources       enable row level security;
alter table public.raw_post_content_changes enable row level security;

revoke all on public.ingest_runs              from anon, authenticated;
revoke all on public.ingest_run_sources       from anon, authenticated;
revoke all on public.raw_post_content_changes from anon, authenticated;

-- anon: nothing. No grant, no policy.
grant select on public.ingest_runs              to authenticated;
grant select on public.ingest_run_sources       to authenticated;
grant select on public.raw_post_content_changes to authenticated;

grant select, insert, update, delete on public.ingest_runs              to service_role;
grant select, insert, update, delete on public.ingest_run_sources       to service_role;
grant select, insert, update, delete on public.raw_post_content_changes to service_role;

create policy ingest_runs_select_for_editors
  on public.ingest_runs for select to authenticated
  using ((select public.is_editor()));

create policy ingest_run_sources_select_for_editors
  on public.ingest_run_sources for select to authenticated
  using ((select public.is_editor()));

create policy content_changes_select_for_editors
  on public.raw_post_content_changes for select to authenticated
  using ((select public.is_editor()));


-- -----------------------------------------------------------------------------
-- Canonical provider identifiers for the four existing sources
-- -----------------------------------------------------------------------------
-- sources.url stays the human/display link. rapidapi_identifier is provider
-- input only, and must be a bare canonical company URL: MASAF's stored url
-- carries '/posts/?feedView=all', which is a browser URL somebody pasted and is
-- not a valid linkedin_url parameter.
--
-- Idempotent and keyed on name, so this is a no-op on an empty database. The
-- legacy loader sets the same values, so a local reset + reload converges here
-- too.
-- -----------------------------------------------------------------------------
update public.sources set rapidapi_identifier = 'https://www.linkedin.com/company/gbfoods-italy'
  where name = 'GBfoods Italy LinkedIn';
update public.sources set rapidapi_identifier = 'https://www.linkedin.com/company/fratelli-branca-distillerie'
  where name = 'Fratelli Branca Distillerie LinkedIn';
update public.sources set rapidapi_identifier = 'https://www.linkedin.com/company/masaf'
  where name = 'MASAF LinkedIn';
update public.sources set rapidapi_identifier = 'https://www.linkedin.com/company/european-commission'
  where name = 'European Commission LinkedIn';

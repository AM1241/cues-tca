-- =============================================================================
-- 0016_generation.sql — Phase 5: cluster-based editorial generation
-- =============================================================================
--
-- See docs/PHASE5_KICKOFF.md for the starting context. This migration does
-- NOT reuse 0001's generation_requests/editorial_assets/traceability_links —
-- those are keyed to a time-window + source-list model with an
-- overwrite-in-place status column, predating the append-only/immutable-
-- result pattern established by Phase 3 (scoring_requests/scoring_results)
-- and Phase 4 (clustering_runs/clusters, anonymize_results). Phase 5 targets
-- clusters, not date windows, needs the same immutable-snapshot discipline,
-- AND the frontend already reads/writes 0001's editorial_assets in the
-- Review/Export routes — so this gets its own, differently-named tables
-- (cluster_generation_*) rather than colliding with or bending the old ones.
-- The 0001 tables are left completely untouched; nothing reads or writes
-- them from this point on.
--
-- Key decisions this schema encodes:
--
--   - One cluster_generation_requests row per invocation of the `generate`
--     function, covering one or more clusters from ONE clustering_run_id.
--     Immutable once created except for its own status/error/completed_at —
--     mirrors clustering_runs' two-phase lifecycle (a row exists the instant
--     work starts, so a crash mid-request still leaves an honest
--     non-completed record instead of nothing).
--   - One cluster_generation_results row per successfully generated cluster —
--     append-only, like anonymize_results/scoring_results. A cluster that
--     fails generation produces NO row here; the failure lives only on
--     cluster_generation_request_errors, per the fail-loud requirement.
--     There is no "current projection" table: a generation result is not
--     overwritten in place by a later run the way anonymized_posts_current
--     or analyzed_posts.current_result_id are — a re-generation is simply a
--     new request producing new immutable rows, and the frontend lists by
--     request/created_at, not by a live pointer.
--   - Traceability is explicit and exact, matching the Phase 4 discipline:
--     the request stores the input scope (run + selected cluster ids); each
--     result stores the exact raw_post_ids and anonymize_result_ids that
--     cluster's posts resolved to AT GENERATION TIME, plus the cluster's own
--     label snapshot — reconstructable even after a later re-anonymisation
--     or re-clustering changes what "current" means.
--   - Config snapshot + prompt version/hash + model snapshot are stored on
--     EVERY result (not just the request) so a partial-failure request (some
--     clusters ok, one cluster's LLM call failed) still lets each successful
--     result answer "what exactly produced this" on its own, without needing
--     to join back to a request that might later fail entirely.
--   - Fail-loud throughout: a cluster belonging to another run, a
--     label_failed cluster, a cluster with no valid assignments, an input
--     lacking a valid anonymisation result, an LLM/schema failure, or a
--     persistence failure all reject that cluster (or the whole request, for
--     upfront validation errors) — never a canned/fallback post or carousel.
--   - Enforced at the database boundary: complete_cluster_generation_result
--     requires the cluster to belong to the request's own clustering_run_id
--     (checked via a join, not trusted from the caller), mirroring
--     cluster_assignments_run_consistency's trigger-enforced approach in
--     0015.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- cluster_generation_requests — one row per invocation of the generate function
-- -----------------------------------------------------------------------------
create table public.cluster_generation_requests (
  id                 uuid primary key default gen_random_uuid(),

  clustering_run_id  uuid not null references public.clustering_runs (id) on delete restrict,
  -- The exact cluster ids requested, as submitted by the caller — kept even
  -- though cluster_generation_results also carries cluster_id per row, so a
  -- request that failed before producing ANY result still records what was
  -- asked for.
  requested_cluster_ids uuid[] not null,
  output_types       text[] not null,

  status             text not null default 'pending'
                       check (status in ('pending', 'completed', 'failed')),
  error_message       text,

  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  completed_at         timestamptz,

  constraint cluster_generation_requests_cluster_ids_not_empty check (cardinality(requested_cluster_ids) > 0),
  constraint cluster_generation_requests_output_types_valid check (
    output_types <@ array['post', 'carousel']::text[] and cardinality(output_types) > 0
  )
);

comment on table public.cluster_generation_requests is
  'One immutable record per generate invocation, covering one or more clusters from one '
  'clustering_run_id. Only status/error_message/completed_at ever change after creation — '
  'mirrors clustering_runs'' two-phase lifecycle (a row exists before any LLM work happens, so '
  'a crash mid-request leaves an honest non-completed record instead of no record at all). '
  'status=''completed'' means every requested cluster produced a result; status=''failed'' means '
  'at least one requested cluster did not (see cluster_generation_request_errors for which, and '
  'why) — there is no partial-success status, so the frontend cannot mistake a partial batch '
  'for a clean one.';

create index cluster_generation_requests_run_idx on public.cluster_generation_requests (clustering_run_id);
create index cluster_generation_requests_created_idx on public.cluster_generation_requests (created_at desc);


-- -----------------------------------------------------------------------------
-- cluster_generation_request_errors — per-cluster failure detail for a request
-- -----------------------------------------------------------------------------
-- Separate from cluster_generation_requests.error_message (which stays as a
-- single top-line summary) because a request can name multiple clusters and
-- more than one can fail for different reasons; each needs its own
-- error_type/message rather than one string concatenating all of them.
-- -----------------------------------------------------------------------------
create table public.cluster_generation_request_errors (
  id                    uuid primary key default gen_random_uuid(),
  generation_request_id uuid not null references public.cluster_generation_requests (id) on delete cascade,
  cluster_id            uuid not null,
  error_type            text not null,
  error_message         text not null,
  created_at            timestamptz not null default now(),

  constraint cluster_generation_request_errors_one_per_cluster unique (generation_request_id, cluster_id)
);

comment on table public.cluster_generation_request_errors is
  'One row per cluster that failed to generate within a request. error_type is a coarse '
  'category (e.g. cluster_not_in_run, label_failed, no_valid_input, llm_error, schema_error, '
  'persistence_error); error_message is the human-readable detail. A cluster appearing here '
  'never has a matching cluster_generation_results row for the same request.';

create index cluster_generation_request_errors_request_idx on public.cluster_generation_request_errors (generation_request_id);


-- -----------------------------------------------------------------------------
-- cluster_generation_results — append-only, one row per successfully generated cluster
-- -----------------------------------------------------------------------------
create table public.cluster_generation_results (
  id                     uuid primary key default gen_random_uuid(),
  generation_request_id  uuid not null references public.cluster_generation_requests (id) on delete restrict,
  clustering_run_id      uuid not null references public.clustering_runs (id) on delete restrict,
  cluster_id             uuid not null references public.clusters (id) on delete restrict,

  -- Traceability snapshot — exact, not re-derivable from a later "current"
  -- state. raw_post_ids / anonymize_result_ids are the precise inputs this
  -- result was generated from, mirroring clustering_run_posts' own
  -- (raw_post_id, anonymize_result_id) pairing discipline.
  cluster_label          text not null,
  raw_post_ids            uuid[] not null,
  anonymize_result_ids    uuid[] not null,

  output_types            text[] not null,
  post_output             jsonb,
  carousel_output          jsonb,

  config_snapshot          jsonb not null,
  prompt_version           text not null,
  prompt_hash              text not null,
  model                   text not null,
  provider_response        jsonb,

  created_at               timestamptz not null default now(),

  constraint cluster_generation_results_one_per_request_cluster unique (generation_request_id, cluster_id),
  constraint cluster_generation_results_traceability_not_empty check (
    cardinality(raw_post_ids) > 0 and cardinality(anonymize_result_ids) > 0
  ),
  constraint cluster_generation_results_post_present check (
    not ('post' = any(output_types)) or post_output is not null
  ),
  constraint cluster_generation_results_carousel_present check (
    not ('carousel' = any(output_types)) or carousel_output is not null
  )
);

comment on table public.cluster_generation_results is
  'Append-only, one row per cluster successfully generated within a request — mirrors '
  'anonymize_results/scoring_results. No UPDATE/DELETE, no current-projection pointer: a later '
  're-generation is simply a new request producing new rows, never an overwrite of this one. '
  'raw_post_ids/anonymize_result_ids/cluster_label are an exact-at-generation-time snapshot, '
  'reconstructable even after a later re-anonymisation or re-clustering run changes what '
  '''current'' means. config_snapshot/prompt_version/prompt_hash/model are stored per-result '
  '(not just on the request) so each successful result independently answers ''what exactly '
  'produced this'', even if a sibling cluster in the same request later fails.';

create index cluster_generation_results_request_idx on public.cluster_generation_results (generation_request_id);
create index cluster_generation_results_cluster_idx on public.cluster_generation_results (cluster_id);
create index cluster_generation_results_run_idx on public.cluster_generation_results (clustering_run_id);
create index cluster_generation_results_created_idx on public.cluster_generation_results (created_at desc);

-- Append-only: UPDATE/DELETE blocked for every caller, same pattern as
-- anonymize_results/scoring_results.
create or replace function public.cluster_generation_results_immutable()
returns trigger language plpgsql as $$
begin raise exception 'cluster_generation_results is append-only (% blocked)', tg_op; end
$$;
create trigger cluster_generation_results_no_update before update on public.cluster_generation_results
  for each row execute function public.cluster_generation_results_immutable();
create trigger cluster_generation_results_no_delete before delete on public.cluster_generation_results
  for each row execute function public.cluster_generation_results_immutable();


-- =============================================================================
-- Lifecycle RPCs — two-phase, mirroring clustering_runs (0015)
-- =============================================================================

-- Phase 1: a real 'pending' row exists before any LLM work happens.
create or replace function public.create_cluster_generation_request(
  p_clustering_run_id uuid,
  p_requested_cluster_ids uuid[],
  p_output_types text[]
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id uuid;
  v_run_status text;
  v_bad_cluster uuid;
begin
  select status into v_run_status from public.clustering_runs where id = p_clustering_run_id;
  if v_run_status is null then
    raise exception 'clustering_run % not found', p_clustering_run_id;
  end if;
  if v_run_status <> 'completed' then
    raise exception 'clustering_run % is not completed (status=%)', p_clustering_run_id, v_run_status;
  end if;

  if p_requested_cluster_ids is null or cardinality(p_requested_cluster_ids) = 0 then
    raise exception 'at least one cluster_id is required';
  end if;

  -- Every requested cluster must belong to THIS run — enforced here, at the
  -- database boundary, not trusted from the caller's own filtering.
  select rc.id into v_bad_cluster
  from unnest(p_requested_cluster_ids) as rc(id)
  left join public.clusters c on c.id = rc.id and c.clustering_run_id = p_clustering_run_id
  where c.id is null
  limit 1;
  if v_bad_cluster is not null then
    raise exception 'cluster % does not belong to clustering_run %', v_bad_cluster, p_clustering_run_id;
  end if;

  insert into public.cluster_generation_requests (
    clustering_run_id, requested_cluster_ids, output_types, status, created_by
  ) values (
    p_clustering_run_id, p_requested_cluster_ids, p_output_types, 'pending', (select auth.uid())
  ) returning id into v_request_id;

  return v_request_id;
end
$$;

comment on function public.create_cluster_generation_request is
  'Phase 1 of 2. Validates the run is completed and every requested cluster_id belongs to it, '
  'then inserts a pending request row before any LLM call happens.';

-- Records one cluster's error within a request. Callable multiple times
-- (once per failing cluster) while the request is still pending.
create or replace function public.record_cluster_generation_error(
  p_request_id uuid,
  p_cluster_id uuid,
  p_error_type text,
  p_error_message text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.cluster_generation_requests where id = p_request_id and status = 'pending' for update;
  if not found then raise exception 'cluster_generation_request % not found or not pending', p_request_id; end if;

  insert into public.cluster_generation_request_errors (generation_request_id, cluster_id, error_type, error_message)
  values (p_request_id, p_cluster_id, p_error_type, p_error_message)
  on conflict (generation_request_id, cluster_id) do update
    set error_type = excluded.error_type, error_message = excluded.error_message;
end
$$;

comment on function public.record_cluster_generation_error is
  'Per-cluster failure detail, recordable incrementally while the request is still pending. '
  'A cluster recorded here must never also get a cluster_generation_results row for the same request.';

-- Persists one cluster's successful generation result. Rejects if the
-- cluster does not belong to the request's own clustering_run_id (defence in
-- depth: create_cluster_generation_request already checked this at
-- request-creation time, but this is the point where a mismatched write
-- would actually land).
create or replace function public.complete_cluster_generation_result(
  p_request_id uuid,
  p_cluster_id uuid,
  p_cluster_label text,
  p_raw_post_ids uuid[],
  p_anonymize_result_ids uuid[],
  p_output_types text[],
  p_post_output jsonb,
  p_carousel_output jsonb,
  p_config_snapshot jsonb,
  p_prompt_version text,
  p_prompt_hash text,
  p_model text,
  p_provider_response jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.cluster_generation_requests%rowtype;
  v_cluster_run_id uuid;
  v_result_id uuid;
begin
  select * into v_request from public.cluster_generation_requests where id = p_request_id for update;
  if not found then raise exception 'cluster_generation_request % not found', p_request_id; end if;
  if v_request.status <> 'pending' then
    raise exception 'cluster_generation_request % is not pending (status=%)', p_request_id, v_request.status;
  end if;

  select clustering_run_id into v_cluster_run_id from public.clusters where id = p_cluster_id;
  if v_cluster_run_id is null then raise exception 'cluster % not found', p_cluster_id; end if;
  if v_cluster_run_id <> v_request.clustering_run_id then
    raise exception 'cluster % does not belong to cluster_generation_request %''s clustering_run %',
      p_cluster_id, p_request_id, v_request.clustering_run_id;
  end if;

  insert into public.cluster_generation_results (
    generation_request_id, clustering_run_id, cluster_id, cluster_label,
    raw_post_ids, anonymize_result_ids, output_types,
    post_output, carousel_output,
    config_snapshot, prompt_version, prompt_hash, model, provider_response
  ) values (
    p_request_id, v_request.clustering_run_id, p_cluster_id, p_cluster_label,
    p_raw_post_ids, p_anonymize_result_ids, p_output_types,
    p_post_output, p_carousel_output,
    p_config_snapshot, p_prompt_version, p_prompt_hash, p_model, p_provider_response
  ) returning id into v_result_id;

  return v_result_id;
end
$$;

comment on function public.complete_cluster_generation_result is
  'Persists one cluster''s successful generation result. Re-derives the cluster''s own run id '
  'from public.clusters and rejects if it does not match the request''s clustering_run_id, '
  'rather than trusting the caller''s own scoping.';

-- Phase 2: mark the request completed or failed. Called exactly once, after
-- every requested cluster has either produced a cluster_generation_results
-- row or a cluster_generation_request_errors row.
create or replace function public.finish_cluster_generation_request(
  p_request_id uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.cluster_generation_requests%rowtype;
  v_result_count integer;
  v_error_count integer;
  v_final_status text;
begin
  select * into v_request from public.cluster_generation_requests where id = p_request_id for update;
  if not found then raise exception 'cluster_generation_request % not found', p_request_id; end if;
  if v_request.status <> 'pending' then
    raise exception 'cluster_generation_request % is not pending (status=%)', p_request_id, v_request.status;
  end if;

  select count(*) into v_result_count from public.cluster_generation_results where generation_request_id = p_request_id;
  select count(*) into v_error_count from public.cluster_generation_request_errors where generation_request_id = p_request_id;

  if v_result_count + v_error_count <> cardinality(v_request.requested_cluster_ids) then
    raise exception
      'cluster_generation_request %: % result(s) + % error(s) does not match % requested cluster(s)',
      p_request_id, v_result_count, v_error_count, cardinality(v_request.requested_cluster_ids);
  end if;

  v_final_status := case when v_error_count = 0 then 'completed' else 'failed' end;

  update public.cluster_generation_requests
     set status = v_final_status,
         error_message = case when v_error_count > 0
           then format('%s of %s requested cluster(s) failed to generate', v_error_count, cardinality(v_request.requested_cluster_ids))
           else null end,
         completed_at = now()
   where id = p_request_id;

  return v_final_status;
end
$$;

comment on function public.finish_cluster_generation_request is
  'Phase 2 of 2. Marks the request completed only if every requested cluster produced a result '
  'and none failed; otherwise failed. Hard-fails if the result+error count does not exactly '
  'match the requested cluster count, so a request can never be closed while a cluster was '
  'silently skipped.';


-- =============================================================================
-- Privileges — SELECT + controlled RPCs; no direct DML on the trusted tables
-- =============================================================================
alter table public.cluster_generation_requests       enable row level security;
alter table public.cluster_generation_request_errors enable row level security;
alter table public.cluster_generation_results         enable row level security;

revoke all on public.cluster_generation_requests       from anon, authenticated;
revoke all on public.cluster_generation_request_errors from anon, authenticated;
revoke all on public.cluster_generation_results         from anon, authenticated;

grant select on public.cluster_generation_requests       to authenticated;
grant select on public.cluster_generation_request_errors to authenticated;
grant select on public.cluster_generation_results         to authenticated;

grant select on public.cluster_generation_requests       to service_role;
grant select on public.cluster_generation_request_errors to service_role;
grant select on public.cluster_generation_results         to service_role;

revoke truncate, trigger, references on
  public.cluster_generation_requests, public.cluster_generation_request_errors, public.cluster_generation_results
  from service_role, authenticated, anon;

create policy cluster_generation_requests_select_for_editors on public.cluster_generation_requests
  for select to authenticated using ((select public.is_editor()));
create policy cluster_generation_request_errors_select_for_editors on public.cluster_generation_request_errors
  for select to authenticated using ((select public.is_editor()));
create policy cluster_generation_results_select_for_editors on public.cluster_generation_results
  for select to authenticated using ((select public.is_editor()));

-- RPC execute grants (service_role only).
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'create_cluster_generation_request(uuid,uuid[],text[])',
    'record_cluster_generation_error(uuid,uuid,text,text)',
    'complete_cluster_generation_result(uuid,uuid,text,uuid[],uuid[],text[],jsonb,jsonb,jsonb,text,text,text,jsonb)',
    'finish_cluster_generation_request(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end
$grants$;

-- =============================================================================
-- 0029_consumption_attribution.sql — ACC-04: attribute every paid path to a caller
-- =============================================================================
--
-- ACC-04 (docs/TCA_TRIAL_HANDOFF.md §2.5) requires that FINT's consumption can
-- be told apart from TechnoAlimenti's. The investigation (same doc, ACC-04
-- Status) found the picture across the six paid paths:
--
--   ingest         — already attributed (ingest_runs.triggered_by / email).
--   scoring        — recorded, never attributed.
--   anonymisation  — recorded, never attributed.
--   clustering     — clustering_runs.created_by exists but is ALWAYS NULL,
--                    because the function discards the actor and writes through
--                    the service-role client, so auth.uid() is null.
--   generation     — same bug as clustering on
--                    cluster_generation_requests.created_by.
--   slide images   — nothing stored at all.
--   editors        — no org/domain column, so "which user" cannot be rolled up
--                    to "which organisation".
--
-- This migration closes the gap with the minimum that makes attribution
-- possible without a billing dashboard:
--
--   - editors.org — one column that turns a caller into an organisation.
--   - scoring_requests.created_by + scoring_results.triggered_by /
--     triggered_by_email — the scoring path becomes attributable like ingest.
--   - anonymize_results.triggered_by / triggered_by_email — same.
--   - create_clustering_run / create_cluster_generation_request gain an
--     explicit p_created_by argument so the caller is passed in rather than
--     read from auth.uid() under a service-role session (which never worked).
--   - slide_image_requests — a new log table; slide-images writes one row per
--     attempt (success or failure), which did not exist before.
--
-- All attribution columns are ON DELETE SET NULL / plain text snapshots, the
-- same discipline ingest_runs already uses (0003): deleting a user must not
-- invalidate history, and the email snapshot keeps history readable after the
-- user is gone. None of these columns is a NOT NULL — internal (cron/backfill)
-- triggers legitimately have no caller, exactly like ingest_runs today.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- editors.org — which organisation an editor belongs to
-- -----------------------------------------------------------------------------
-- Nullable and open-ended on purpose: existing accounts predate this column,
-- and the trial is a single partner. It is a label for grouping, not an FK
-- into a catalog that does not exist.
alter table public.editors
  add column org text;

comment on column public.editors.org is
  'Which organisation this editor belongs to (e.g. FINT vs TechnoAlimenti). '
  'Free text, nullable: the grouping key that turns "which caller" into "which '
  'organisation" for consumption attribution (ACC-04). Pre-dates existing accounts.';


-- -----------------------------------------------------------------------------
-- scoring_requests.created_by — who opened the scoring run
-- -----------------------------------------------------------------------------
-- The request is the run-level definition a batch of jobs copies from, so the
-- caller belongs here, exactly as it does on clustering_runs. Jobs inherit
-- their request, so one column covers every job under the request.
alter table public.scoring_requests
  add column created_by uuid references auth.users (id) on delete set null;

comment on column public.scoring_requests.created_by is
  'Who opened this scoring request. Null for requests created by internal '
  '(cron/backfill) callers or by hand in SQL. Jobs inherit the request, so this '
  'one column attributes every job under it (ACC-04).';


-- -----------------------------------------------------------------------------
-- scoring_results.triggered_by / triggered_by_email — per-result attribution
-- -----------------------------------------------------------------------------
-- Stored per result (not only on the request) because a result is the append-only
-- record that outlives the request, and because a result must answer "who paid
-- for this call" on its own — the same reasoning that puts config_snapshot and
-- provider_response on every result rather than only on the request.
alter table public.scoring_results
  add column triggered_by       uuid references auth.users (id) on delete set null,
  add column triggered_by_email text;

comment on column public.scoring_results.triggered_by is
  'The editor who drained the queue that scored this post, if any. Null for '
  'internal (cron/backfill) callers and for legacy imported rows. See ACC-04.';
comment on column public.scoring_results.triggered_by_email is
  'Email snapshot of triggered_by, kept so history stays readable after the user '
  'is deleted. See ACC-04.';


-- -----------------------------------------------------------------------------
-- anonymize_results.triggered_by / triggered_by_email — per-result attribution
-- -----------------------------------------------------------------------------
alter table public.anonymize_results
  add column triggered_by       uuid references auth.users (id) on delete set null,
  add column triggered_by_email text;

comment on column public.anonymize_results.triggered_by is
  'The editor who drained the queue that anonymised this post, if any. Null for '
  'internal callers. See ACC-04.';
comment on column public.anonymize_results.triggered_by_email is
  'Email snapshot of triggered_by, kept so history stays readable after the user '
  'is deleted. See ACC-04.';


-- -----------------------------------------------------------------------------
-- create_clustering_run — accept the caller explicitly
-- -----------------------------------------------------------------------------
-- The old body read (select auth.uid()), which is NULL under the service-role
-- client the Edge Function writes with — so created_by was always NULL despite
-- the column existing since 0015. The function now takes the caller as an
-- argument and falls back to auth.uid() only when the caller passes null, so a
-- direct Postgres call still records who is logged in, and the Edge Function
-- passes the actor it already resolved.
drop function if exists public.create_clustering_run(timestamptz, timestamptz, numeric, numeric, integer, text);
create function public.create_clustering_run(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_min_relevance_score numeric,
  p_cluster_similarity_threshold numeric,
  p_min_cluster_size integer,
  p_embedding_model text,
  p_created_by uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_run_id uuid;
begin
  if p_period_end < p_period_start then
    raise exception 'period_end must not be before period_start';
  end if;

  insert into public.clustering_runs (
    period_start, period_end, min_relevance_score, cluster_similarity_threshold,
    min_cluster_size, embedding_model, status, created_by
  ) values (
    p_period_start, p_period_end, p_min_relevance_score, p_cluster_similarity_threshold,
    p_min_cluster_size, p_embedding_model, 'running',
    coalesce(p_created_by, (select auth.uid()))
  ) returning id into v_run_id;

  return v_run_id;
end
$$;

comment on function public.create_clustering_run(timestamptz,timestamptz,numeric,numeric,integer,text,uuid) is
  'Phase 1 of 2. Inserts a running run row and returns its id before any embedding or '
  'labeling work happens, so a total failure before completion still leaves an honest '
  '(non-completed) audit record instead of no record at all. p_created_by is the caller, '
  'passed explicitly because the Edge Function writes through the service-role client, '
  'under which auth.uid() would be NULL (ACC-04).';

revoke all on function public.create_clustering_run(timestamptz,timestamptz,numeric,numeric,integer,text,uuid)
  from public, anon, authenticated;
grant execute on function public.create_clustering_run(timestamptz,timestamptz,numeric,numeric,integer,text,uuid)
  to service_role;


-- -----------------------------------------------------------------------------
-- create_cluster_generation_request — accept the caller explicitly
-- -----------------------------------------------------------------------------
-- Same fix as create_clustering_run: the column has existed since 0016 but was
-- always NULL because the function read auth.uid() under the service-role
-- client. Dropped and recreated with an explicit trailing argument (not an
-- overload — the existing 8-argument call must stay unambiguous).
drop function if exists public.create_cluster_generation_request(uuid, uuid[], text[], text, uuid, text, timestamptz, timestamptz);
create function public.create_cluster_generation_request(
  p_clustering_run_id uuid,
  p_requested_cluster_ids uuid[],
  p_output_types text[],
  p_feedback text default null,
  p_regenerates_result_id uuid default null,
  p_kind text default 'per_cluster',
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_created_by uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare
  v_request_id uuid;
  v_run_status text;
  v_bad_cluster uuid;
  v_prev_kind text;
  v_prev_cluster_id uuid;
  v_prev_output_types text[];
begin
  if p_kind not in ('per_cluster', 'publication') then
    raise exception 'unknown generation kind %', p_kind;
  end if;

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

  -- Regeneration invariants. A regeneration whose "previous draft" belongs to
  -- another cluster would put unrelated copy in the prompt and silently
  -- produce something nobody asked for.
  if p_regenerates_result_id is not null then
    select kind, cluster_id, output_types
      into v_prev_kind, v_prev_cluster_id, v_prev_output_types
      from public.cluster_generation_results where id = p_regenerates_result_id;
    if v_prev_kind is null then
      raise exception 'cluster_generation_result % not found', p_regenerates_result_id;
    end if;
    -- A revision answers a specific draft, so it must be the same shape: a
    -- publication cannot "revise" a single-cluster draft, or the editor's note
    -- would be applied to something they were not reading.
    if v_prev_kind <> p_kind then
      raise exception 'result % is a % draft, cannot regenerate it as a %',
        p_regenerates_result_id, v_prev_kind, p_kind;
    end if;
    if p_kind = 'per_cluster' then
      if cardinality(p_requested_cluster_ids) <> 1 then
        raise exception 'a regeneration covers exactly one cluster, got %',
          cardinality(p_requested_cluster_ids);
      end if;
      if p_requested_cluster_ids[1] <> v_prev_cluster_id then
        raise exception 'result % belongs to cluster %, not %',
          p_regenerates_result_id, v_prev_cluster_id, p_requested_cluster_ids[1];
      end if;
    end if;
    -- You cannot improve on a draft that was never produced.
    if not (p_output_types <@ v_prev_output_types) then
      raise exception 'result % has outputs %, cannot regenerate %',
        p_regenerates_result_id, v_prev_output_types, p_output_types;
    end if;
  end if;

  insert into public.cluster_generation_requests (
    clustering_run_id, requested_cluster_ids, output_types, status, created_by,
    feedback, regenerates_result_id, kind, period_start, period_end
  ) values (
    p_clustering_run_id, p_requested_cluster_ids, p_output_types, 'pending',
    coalesce(p_created_by, (select auth.uid())),
    nullif(btrim(coalesce(p_feedback, '')), ''), p_regenerates_result_id,
    p_kind, p_period_start, p_period_end
  ) returning id into v_request_id;

  return v_request_id;
end
$fn$;

comment on function public.create_cluster_generation_request(uuid,uuid[],text[],text,uuid,text,timestamptz,timestamptz,uuid) is
  'Opens a generation request. p_kind selects the shape: per_cluster produces one draft '
  'per selected cluster; publication produces a single post and carousel synthesised '
  'across all of them, over the period the operator chose. Validates run status, cluster '
  'membership and — for a revision — that the previous draft is the same shape. '
  'p_created_by is the caller, passed explicitly because the Edge Function writes through '
  'the service-role client, under which auth.uid() would be NULL (ACC-04).';

revoke all on function public.create_cluster_generation_request(uuid,uuid[],text[],text,uuid,text,timestamptz,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.create_cluster_generation_request(uuid,uuid[],text[],text,uuid,text,timestamptz,timestamptz,uuid)
  to service_role;


-- -----------------------------------------------------------------------------
-- complete_scoring_job / complete_anonymize_job — accept the caller
-- -----------------------------------------------------------------------------
-- A scoring/anonymisation result is written inside these completion RPCs, so
-- the caller must be threaded into them for per-result attribution. They are
-- dropped and recreated with a trailing defaulted argument (never an overload —
-- existing call sites must stay unambiguous).
drop function if exists public.complete_scoring_job(uuid, bigint, uuid, uuid, jsonb, text, jsonb, uuid);
create function public.complete_scoring_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_theme_scores jsonb, p_reason text, p_provider_response jsonb default null,
  p_processing_token uuid default null,
  p_triggered_by uuid default null,
  p_triggered_by_email text default null
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
    config_snapshot, config_hash, scoring_job_id, provider_response, idempotency_key,
    triggered_by, triggered_by_email
  ) values (
    p_raw_post_id, v_req.id, 'openai', 'llm_verified', true,
    v_req.model, v_req.model_snapshot, v_req.prompt_version, v_req.aggregation_strategy,
    p_theme_scores, v_overall, p_reason, v_included,
    v_req.config_snapshot, v_req.config_hash, p_job_id, p_provider_response, v_idk,
    p_triggered_by, p_triggered_by_email
  )
  on conflict (idempotency_key) do nothing
  returning id into v_result_id;

  update public.scoring_job_state set status = 'succeeded', updated_at = now() where id = p_job_id;
  if p_msg_id is not null then perform pgmq.archive('scoring_jobs', p_msg_id); end if;

  return case when v_result_id is null then 'duplicate' else 'inserted' end;
end
$$;
revoke all on function public.complete_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.complete_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid,uuid,text) to service_role;

-- complete_and_promote_scoring_job must forward the same two attribution
-- arguments into complete_scoring_job, or the promote path would strip them.
drop function if exists public.complete_and_promote_scoring_job(uuid, bigint, uuid, uuid, jsonb, text, jsonb, uuid);
create function public.complete_and_promote_scoring_job(
  p_job_id uuid,
  p_msg_id bigint,
  p_raw_post_id uuid,
  p_scoring_request_id uuid,
  p_theme_scores jsonb,
  p_reason text,
  p_provider_response jsonb default null,
  p_processing_token uuid default null,
  p_triggered_by uuid default null,
  p_triggered_by_email text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_outcome text;
  v_result_id uuid;
begin
  v_outcome := public.complete_scoring_job(
    p_job_id, p_msg_id, p_raw_post_id, p_scoring_request_id,
    p_theme_scores, p_reason, p_provider_response, p_processing_token,
    p_triggered_by, p_triggered_by_email
  );

  if v_outcome not in ('inserted', 'duplicate') then
    return v_outcome;
  end if;

  select id into v_result_id
    from public.scoring_results
   where raw_post_id = p_raw_post_id
     and scoring_request_id = p_scoring_request_id
   order by created_at desc
   limit 1;

  if v_result_id is null then
    raise exception
      'complete_scoring_job returned % but no scoring_result exists for raw_post % / request %',
      v_outcome, p_raw_post_id, p_scoring_request_id;
  end if;

  perform public.set_current_scoring_result(p_raw_post_id, v_result_id);

  return v_outcome;
end
$$;

comment on function public.complete_and_promote_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid,uuid,text) is
  'Completes a scoring job and projects its result onto analyzed_posts in one transaction. '
  'Forwards the caller through to complete_scoring_job so the promote path keeps per-result '
  'attribution (ACC-04).';

revoke all on function public.complete_and_promote_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.complete_and_promote_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid,uuid,text)
  to service_role;

-- complete_anonymize_job gains the same two trailing arguments.
drop function if exists public.complete_anonymize_job(uuid, bigint, uuid, text, jsonb, text, boolean, jsonb, jsonb, uuid);
create function public.complete_anonymize_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid,
  p_anonymized_text text, p_replacements jsonb, p_generalized_source_name text,
  p_entity_extraction_used boolean, p_config_snapshot jsonb,
  p_provider_response jsonb default null, p_processing_token uuid default null,
  p_triggered_by uuid default null,
  p_triggered_by_email text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.anonymize_job_state%rowtype;
  v_source_name text; v_overall numeric; v_idk text; v_result_id uuid; v_hash text;
begin
  select * into v_job from public.anonymize_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;

  if v_job.processing_token is distinct from p_processing_token then return 'superseded'; end if;
  if v_job.status = 'succeeded' then return 'duplicate'; end if;
  if v_job.status not in ('pending','processing') then return 'superseded'; end if;

  if not p_entity_extraction_used then
    raise exception 'complete_anonymize_job requires entity_extraction_used=true; a failed LLM pass must call record_anonymize_failure instead';
  end if;

  select s.name, a.overall_relevance into v_source_name, v_overall
  from public.raw_posts rp
  join public.sources s on s.id = rp.source_id
  join public.analyzed_posts a on a.raw_post_id = rp.id
  where rp.id = p_raw_post_id;
  if v_source_name is null then raise exception 'raw_post % has no scored analysis to anonymise', p_raw_post_id; end if;

  v_hash := md5(p_config_snapshot::text);
  v_idk := md5(concat_ws('|', p_raw_post_id::text, v_hash, p_anonymized_text));

  insert into public.anonymize_results (
    raw_post_id, source_name, generalized_source_name, overall_relevance,
    anonymized_text, replacements, entity_extraction_used,
    config_snapshot, config_hash, anonymize_job_id, provider_response, idempotency_key,
    triggered_by, triggered_by_email
  ) values (
    p_raw_post_id, v_source_name, p_generalized_source_name, v_overall,
    p_anonymized_text, coalesce(p_replacements, '[]'::jsonb), true,
    p_config_snapshot, v_hash, p_job_id, p_provider_response, v_idk,
    p_triggered_by, p_triggered_by_email
  )
  on conflict (idempotency_key) do nothing
  returning id into v_result_id;

  if v_result_id is null then
    select id into v_result_id from public.anonymize_results where idempotency_key = v_idk;
  end if;

  insert into public.anonymized_posts_current (
    raw_post_id, source_name, generalized_source_name, overall_relevance,
    anonymized_text, replacements, config_snapshot, current_result_id
  ) values (
    p_raw_post_id, v_source_name, p_generalized_source_name, v_overall,
    p_anonymized_text, coalesce(p_replacements, '[]'::jsonb), p_config_snapshot, v_result_id
  )
  on conflict (raw_post_id) do update
    set source_name = excluded.source_name,
        generalized_source_name = excluded.generalized_source_name,
        overall_relevance = excluded.overall_relevance,
        anonymized_text = excluded.anonymized_text,
        replacements = excluded.replacements,
        config_snapshot = excluded.config_snapshot,
        current_result_id = excluded.current_result_id,
        updated_at = now();

  update public.anonymize_job_state set status = 'succeeded', updated_at = now() where id = p_job_id;
  if p_msg_id is not null then perform pgmq.archive('anonymize_jobs', p_msg_id); end if;

  return case when v_result_id is null then 'duplicate' else 'inserted' end;
end
$$;

comment on function public.complete_anonymize_job(uuid,bigint,uuid,text,jsonb,text,boolean,jsonb,jsonb,uuid,uuid,text) is
  'Completes an anonymise job fail-loud. The two trailing arguments record the caller on '
  'the result for ACC-04 attribution, mirroring scoring.';

revoke all on function public.complete_anonymize_job(uuid,bigint,uuid,text,jsonb,text,boolean,jsonb,jsonb,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.complete_anonymize_job(uuid,bigint,uuid,text,jsonb,text,boolean,jsonb,jsonb,uuid,uuid,text)
  to service_role;


-- -----------------------------------------------------------------------------
-- slide_image_requests — one row per slide-image attempt
-- -----------------------------------------------------------------------------
-- The only paid path with no record at all (slide-images is deliberately
-- stateless — its own header documents why). One append-only row per attempt,
-- success or failure, gives ACC-04 something to attribute without introducing
-- a Storage bucket or a cleanup job. The image itself stays un-stored, exactly
-- as before.
create table public.slide_image_requests (
  id             uuid primary key default gen_random_uuid(),

  position       integer not null check (position >= 1 and position <= 20),
  quality        text not null check (quality in ('low', 'medium', 'high')),
  model          text not null,

  -- Attribution, same discipline as ingest_runs (0003): nullable, snapshot
  -- email kept for readability after the user is gone.
  triggered_by       uuid references auth.users (id) on delete set null,
  triggered_by_email text,

  status         text not null check (status in ('succeeded', 'failed')),
  error_type     text,
  error_message  text,

  created_at     timestamptz not null default now()
);

comment on table public.slide_image_requests is
  'One append-only row per slide-image generation attempt (ACC-04). The image itself is '
  'still not stored — this is attribution and volume only, not the artefact.';

alter table public.slide_image_requests enable row level security;

revoke all on public.slide_image_requests from anon, authenticated;
grant select on public.slide_image_requests to authenticated;
grant select, insert on public.slide_image_requests to service_role;

revoke truncate, trigger, references on public.slide_image_requests from service_role, authenticated, anon;

create policy slide_image_requests_select_for_editors on public.slide_image_requests
  for select to authenticated using ((select public.is_editor()));

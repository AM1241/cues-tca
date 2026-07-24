-- =============================================================================
-- 0015_clustering.sql — Phase 4: pgvector embeddings + immutable clustering runs
-- =============================================================================
--
-- See docs/PHASE4_REQUIREMENTS.md §3 for the confirmed product spec. Key
-- decisions this schema encodes:
--
--   - Recompute-all per run, no incremental/stable clustering. Cluster ids
--     and labels MAY change between runs — callers must reference
--     (clustering_run_id, cluster_id) together, never a bare cluster_id.
--   - Every run is an immutable, reproducible record: the exact input
--     (raw_post_id, anonymize_result_id) pairs, the requested period, and the
--     effective config values (embedding model, similarity threshold, min
--     cluster size) used AT THAT TIME are snapshotted onto the run row. A
--     later edit to configurations, or a later re-anonymisation of a post,
--     must never retroactively change what a past run is understood to have
--     used — this is why the exact anonymize_result_id is recorded, not just
--     raw_post_id: anonymized_posts_current is overwrite-in-place and would
--     otherwise make history unreconstructable.
--   - Embeddings are keyed by (anonymize_result_id, model), not raw_post_id.
--     A post whose anonymisation changed (re-run with different config, or
--     a new entity found) or whose embedding model changed gets a genuinely
--     new embedding row — there is no stale-but-still-matched row to
--     accidentally reuse, because the key itself no longer matches.
--   - The similarity/grouping math runs in the Edge Function (TypeScript),
--     not in SQL — this migration only defines storage + RLS. The Edge
--     Function fetches embeddings, groups them, then persists the result
--     through the RPCs below.
--   - Run lifecycle is two-phase: create_clustering_run() inserts a 'running'
--     row and returns its id before any embedding/labeling work happens;
--     complete_clustering_run() persists clusters/assignments and marks
--     'completed' only on genuine success. fail_clustering_run() (already
--     existed) marks 'failed' with a reason. A run row that exists always
--     reflects a real attempt — there is no path that reports success
--     without having actually clustered something real.
--   - cluster_similarity_threshold / min_cluster_size already live on
--     configurations as of 0014, alongside the rest of Phase 4's schema.
-- =============================================================================

create extension if not exists vector;


-- -----------------------------------------------------------------------------
-- post_embeddings — one row per (anonymize_result_id, model)
-- -----------------------------------------------------------------------------
-- NOT keyed by raw_post_id: the embedding is a function of the exact
-- anonymised text (anonymize_results.anonymized_text) and the model used to
-- embed it, not of the post in the abstract. A post re-anonymised (new
-- anonymize_results row) or re-embedded with a different model therefore
-- gets a genuinely new row here — there is nothing to explicitly invalidate,
-- because the old row's key simply no longer matches "the current result
-- with the current model". Old rows for superseded results are harmless
-- history, not correctness risk (nothing looks them up by raw_post_id alone).
-- -----------------------------------------------------------------------------
create table public.post_embeddings (
  anonymize_result_id uuid not null,
  model                text not null,
  raw_post_id          uuid not null,
  embedding            vector(1536) not null,
  created_at           timestamptz not null default now(),

  primary key (anonymize_result_id, model),

  -- Composite FK against anonymize_results(id, raw_post_id) (see 0014's
  -- anonymize_results_id_raw_post_id_uniq) — NOT just
  -- "anonymize_result_id references anonymize_results(id)" plus a separate,
  -- independent "raw_post_id references raw_posts(id)". The composite form
  -- is what makes the database itself reject a raw_post_id paired with a
  -- DIFFERENT post's anonymize_result_id: the pair must exist together as a
  -- real (result, its own post) combination, not two independently-valid
  -- ids that happen to be inserted side by side.
  constraint post_embeddings_result_matches_post
    foreign key (anonymize_result_id, raw_post_id)
    references public.anonymize_results (id, raw_post_id)
    on delete cascade
);

comment on table public.post_embeddings is
  'One embedding per (anonymize_result_id, model). Changing the current anonymisation result '
  'or the embedding model always produces a new row — there is no stale row that could be '
  'silently reused. The composite FK to anonymize_results(id, raw_post_id) means raw_post_id '
  'cannot be paired with a mismatched anonymize_result_id — the database enforces the pairing, '
  'not just application code.';

-- Fast "does this exact (result, model) already have an embedding" check —
-- the primary key already covers this, but a post-scoped lookup (all
-- embeddings ever computed for a post, across results/models) is also a
-- real access pattern the inspection UI and cluster function both use.
create index post_embeddings_raw_post_idx on public.post_embeddings (raw_post_id);


-- -----------------------------------------------------------------------------
-- clustering_runs — the immutable definition + record of one clustering pass
-- -----------------------------------------------------------------------------
create table public.clustering_runs (
  id                            uuid primary key default gen_random_uuid(),

  period_start                  timestamptz not null,
  period_end                    timestamptz not null,

  -- Effective config values AT THE TIME this run executed, copied from
  -- configurations (or the caller's override), never re-read live later.
  min_relevance_score           numeric(5,2) not null,
  cluster_similarity_threshold  numeric(3,2) not null,
  min_cluster_size              integer not null,
  embedding_model               text not null,

  status                        text not null default 'running'
                                  check (status in ('running', 'completed', 'failed')),
  error_message                 text,

  created_by                    uuid references auth.users (id) on delete set null,
  created_at                    timestamptz not null default now(),
  completed_at                  timestamptz,

  constraint clustering_runs_period_order check (period_end >= period_start)
);

comment on table public.clustering_runs is
  'One immutable record per clustering execution. Cluster ids are only meaningful '
  'paired with their clustering_run_id — a later run may assign different ids/labels '
  'to the same posts. Config values here are a snapshot, not a live reference. A row '
  'existing at all means a real attempt was made — status=running left permanently '
  'means the invocation crashed before completing/failing, not that nothing happened.';

create index clustering_runs_created_idx on public.clustering_runs (created_at desc);


-- -----------------------------------------------------------------------------
-- clustering_run_posts — the exact input set, for reproducibility
-- -----------------------------------------------------------------------------
-- Normalised join table rather than a uuid[] column, matching the existing
-- traceability_link_posts precedent (0001) — indexable or bulk-queryable.
-- Stores the exact anonymize_result_id used for each post, not just the
-- raw_post_id: anonymized_posts_current is overwrite-in-place, so without
-- this a later re-anonymisation would make it impossible to reconstruct
-- which anonymised text a historical run actually clustered on.
-- -----------------------------------------------------------------------------
create table public.clustering_run_posts (
  clustering_run_id   uuid not null references public.clustering_runs (id) on delete cascade,
  raw_post_id          uuid not null references public.raw_posts (id) on delete restrict,
  anonymize_result_id uuid not null,

  -- Per-post embedding outcome audit — minimum fields, not a generic job
  -- framework. 'pending' at insert time (before the Edge Function has tried
  -- to embed it); the recording RPC below moves it to 'embedded' or
  -- 'failed'. A partial failure stays queryable in this row forever, even
  -- after the HTTP response that reported it is long gone.
  embedding_status       text not null default 'pending'
                           check (embedding_status in ('pending', 'embedded', 'failed')),
  embedding_error_message text,
  embedding_outcome_at    timestamptz,

  primary key (clustering_run_id, raw_post_id),

  -- Composite FK against anonymize_results(id, raw_post_id) — same reasoning
  -- as post_embeddings above: the database rejects a raw_post_id paired with
  -- a mismatched anonymize_result_id, not just each id independently valid.
  constraint clustering_run_posts_result_matches_post
    foreign key (anonymize_result_id, raw_post_id)
    references public.anonymize_results (id, raw_post_id)
    on delete restrict
);

comment on table public.clustering_run_posts is
  'The exact input set a run clustered over, including which anonymize_results row (not just '
  'which post) was used — reconstructable even after anonymized_posts_current later changes. '
  'embedding_status/embedding_error_message are this run''s own audit of what happened when '
  'embedding this specific post, independent of the run''s overall completed/failed status.';

create index clustering_run_posts_raw_post_idx on public.clustering_run_posts (raw_post_id);
-- Composite FK target for cluster_assignments (see below) — the (run_id,
-- raw_post_id) pair is already the primary key and therefore already
-- indexed/unique, so no separate index is needed for that reference.


-- -----------------------------------------------------------------------------
-- clusters — one row per cluster found in one run
-- -----------------------------------------------------------------------------
create table public.clusters (
  id                 uuid primary key default gen_random_uuid(),
  clustering_run_id  uuid not null references public.clustering_runs (id) on delete cascade,
  label              text not null,
  -- True when the label-generation LLM call failed for this cluster. The
  -- cluster and its assignments are still real (the clustering decision
  -- itself succeeded); only the label is a fallback placeholder, and that
  -- fallback is never presented as if labeling succeeded (see
  -- PHASE4_REQUIREMENTS.md's fail-loud principle applied to labeling too).
  label_failed       boolean not null default false,
  centroid           vector(1536),
  post_count         integer not null check (post_count >= 0),
  created_at         timestamptz not null default now()
);

comment on table public.clusters is
  'Clusters have no meaning outside their run — cascades with clustering_runs. '
  'label_failed=true means the label is a placeholder, not a real editorial title.';

create index clusters_run_idx on public.clusters (clustering_run_id);


-- -----------------------------------------------------------------------------
-- cluster_assignments — post -> cluster mapping for one run
-- -----------------------------------------------------------------------------
-- clustering_run_id is denormalised here (set by complete_clustering_run from
-- the cluster row it just inserted, never caller-supplied directly) so both
-- integrity rules below can be real, DB-enforced constraints rather than
-- application-level assumptions:
--   1. "a raw post belongs to at most one cluster within one run" — a unique
--      index on (clustering_run_id, raw_post_id).
--   2. "every assignment belongs to the run's snapshotted input set" — a
--      composite foreign key against clustering_run_posts(clustering_run_id,
--      raw_post_id), which cannot reference a post that was never part of
--      this run's input set in the first place.
-- -----------------------------------------------------------------------------
create table public.cluster_assignments (
  cluster_id          uuid not null references public.clusters (id) on delete cascade,
  clustering_run_id    uuid not null,
  raw_post_id          uuid not null,

  primary key (cluster_id, raw_post_id),

  constraint cluster_assignments_one_cluster_per_post_per_run
    unique (clustering_run_id, raw_post_id),

  -- ON DELETE CASCADE, not RESTRICT: clustering_runs -> clustering_run_posts
  -- and clustering_runs -> clusters -> cluster_assignments are two separate
  -- cascade paths from the same delete of a clustering_runs row. If this FK
  -- were RESTRICT, deleting a run would try to cascade-delete
  -- clustering_run_posts while a still-present cluster_assignments row
  -- (about to be cascade-deleted via the OTHER path, from clusters) still
  -- referenced it — a real ordering conflict, not a hypothetical one
  -- (reproduced while writing scripts/verify_phase4.sql's cascade-integrity
  -- assertion). CASCADE here means both paths converge on removing the same
  -- cluster_assignments rows without racing.
  constraint cluster_assignments_post_in_run_input
    foreign key (clustering_run_id, raw_post_id)
    references public.clustering_run_posts (clustering_run_id, raw_post_id)
    on delete cascade
);

comment on table public.cluster_assignments is
  'Post -> cluster mapping for one run. clustering_run_id is denormalised from the parent '
  'cluster row so two real constraints can be enforced: one cluster per post per run '
  '(cluster_assignments_one_cluster_per_post_per_run), and every assignment must reference '
  'a post that was actually part of this run''s snapshotted input set '
  '(cluster_assignments_post_in_run_input, a composite FK into clustering_run_posts).';

create index cluster_assignments_raw_post_idx on public.cluster_assignments (raw_post_id);

-- clustering_run_id must actually match cluster_id's own run — otherwise a
-- caller could satisfy the FK above by attaching a real (run, post) pair from
-- the WRONG run to a cluster belonging to a different run. Enforced with a
-- trigger since Postgres has no native "column must equal a value looked up
-- via another FK" constraint.
create or replace function public.cluster_assignments_run_consistency()
returns trigger language plpgsql as $$
declare v_run_id uuid;
begin
  select clustering_run_id into v_run_id from public.clusters where id = new.cluster_id;
  if v_run_id is null then
    raise exception 'cluster % not found', new.cluster_id;
  end if;
  if v_run_id <> new.clustering_run_id then
    raise exception 'cluster_assignments.clustering_run_id (%) does not match cluster %''s own run (%)',
      new.clustering_run_id, new.cluster_id, v_run_id;
  end if;
  return new;
end
$$;
create trigger cluster_assignments_run_consistency_check
  before insert or update on public.cluster_assignments
  for each row execute function public.cluster_assignments_run_consistency();


-- =============================================================================
-- Run lifecycle — two-phase so a real 'running' row exists before any
-- embedding/labeling work, and failure never masquerades as completion.
-- =============================================================================
create or replace function public.create_clustering_run(
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_min_relevance_score numeric,
  p_cluster_similarity_threshold numeric,
  p_min_cluster_size integer,
  p_embedding_model text
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
    p_min_cluster_size, p_embedding_model, 'running', (select auth.uid())
  ) returning id into v_run_id;

  return v_run_id;
end
$$;

comment on function public.create_clustering_run is
  'Phase 1 of 2. Inserts a running run row and returns its id before any embedding or '
  'labeling work happens, so a total failure before completion still leaves an honest '
  '(non-completed) audit record instead of no record at all.';

-- Records the run's exact input set (raw_post_id + the anonymize_result_id
-- actually used for each). Separate from create_clustering_run so the Edge
-- Function can record the input set as soon as it's determined, even if
-- embedding/clustering fails afterward — the input set itself is real
-- regardless of what happens next.
--
-- No ON CONFLICT DO NOTHING: a historical run's input set is written exactly
-- once, in one call, and is never meant to be silently topped up or
-- resubmitted. A caller that (by bug or duplicate retry) submits the same
-- raw_post_id twice in one payload, or calls this a second time for a run
-- that already has input recorded, gets a clear exception — not a quiet
-- no-op that could mask a real double-submission or duplicate-post bug in
-- the caller. If a genuinely idempotent retry is ever needed, that has to be
-- a deliberate design decision, not a default swallowed by ON CONFLICT.
create or replace function public.record_clustering_run_input(
  p_run_id uuid,
  -- [{ raw_post_id, anonymize_result_id }, ...]
  p_input jsonb
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_row jsonb; v_count int := 0; v_raw_post_id uuid; v_seen uuid[] := array[]::uuid[];
begin
  perform 1 from public.clustering_runs where id = p_run_id and status = 'running' for update;
  if not found then raise exception 'clustering_run % not found or not running', p_run_id; end if;

  if exists (select 1 from public.clustering_run_posts where clustering_run_id = p_run_id) then
    raise exception 'clustering_run % already has an input set recorded; it is written exactly once', p_run_id;
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_input, '[]'::jsonb)) loop
    if (v_row ->> 'raw_post_id') is null or (v_row ->> 'anonymize_result_id') is null then
      raise exception 'each input entry requires raw_post_id and anonymize_result_id';
    end if;
    v_raw_post_id := (v_row ->> 'raw_post_id')::uuid;
    if v_raw_post_id = any(v_seen) then
      raise exception 'raw_post_id % is duplicated within this input payload', v_raw_post_id;
    end if;
    v_seen := array_append(v_seen, v_raw_post_id);

    insert into public.clustering_run_posts (clustering_run_id, raw_post_id, anonymize_result_id)
    values (p_run_id, v_raw_post_id, (v_row ->> 'anonymize_result_id')::uuid);
    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

comment on function public.record_clustering_run_input is
  'Phase 1b. Records the exact (raw_post_id, anonymize_result_id) pairs this run is '
  'operating over, before embedding/clustering happens. Written exactly once per run.';

-- Records what happened when the Edge Function tried to obtain an embedding
-- for one input post — cached-reuse and freshly-computed both count as
-- 'embedded'; any embedding-call failure is 'failed' with its error message.
-- Callable per-post, incrementally, while the run is still 'running' — this
-- is the audit trail that survives independently of the run's own overall
-- completed/failed status and independently of the HTTP response.
create or replace function public.record_embedding_outcome(
  p_run_id uuid,
  p_raw_post_id uuid,
  p_status text,
  p_error_message text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('embedded', 'failed') then
    raise exception 'record_embedding_outcome: status must be embedded or failed, got %', p_status;
  end if;

  perform 1 from public.clustering_runs where id = p_run_id and status = 'running' for update;
  if not found then raise exception 'clustering_run % not found or not running', p_run_id; end if;

  update public.clustering_run_posts
     set embedding_status = p_status,
         embedding_error_message = case when p_status = 'failed' then p_error_message else null end,
         embedding_outcome_at = now()
   where clustering_run_id = p_run_id and raw_post_id = p_raw_post_id;

  if not found then
    raise exception 'raw_post % is not part of clustering_run %''s recorded input set', p_raw_post_id, p_run_id;
  end if;
end
$$;

comment on function public.record_embedding_outcome is
  'Per-post embedding outcome audit, recordable incrementally while the run is still running. '
  'Not a generic job framework — just enough to answer "did this specific input post get '
  'embedded, and if not, why" after the fact, independent of the run''s overall status.';

-- Phase 2 (success path): persist clusters + assignments, mark 'completed'.
-- Validates every post_ids entry against the run's own recorded input set,
-- rejects duplicate post ids across (or within) clusters, rejects any post
-- whose embedding_status isn't 'embedded' (a failed input cannot be
-- assigned), and computes each cluster's centroid using ONLY embeddings
-- produced by the run's OWN embedding_model — never averaging vectors from
-- two different models together, which would be numerically meaningless
-- (different models' embedding spaces are not comparable). Before writing
-- anything, hard-fails if any assigned post does not have EXACTLY ONE
-- embedding row for that model.
create or replace function public.complete_clustering_run(
  p_run_id uuid,
  -- [{ label, label_failed, post_ids: uuid[] }, ...]
  p_clusters jsonb
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.clustering_runs%rowtype;
  v_cluster jsonb;
  v_cluster_id uuid;
  v_label text;
  v_label_failed boolean;
  v_post_ids jsonb;
  v_centroid public.vector(1536);
  v_count integer;
  v_embedding_count integer;
  v_seen_posts uuid[] := array[]::uuid[];
  v_post_id uuid;
  v_embed_status text;
begin
  select * into v_run from public.clustering_runs where id = p_run_id for update;
  if not found then raise exception 'clustering_run % not found', p_run_id; end if;
  if v_run.status <> 'running' then raise exception 'clustering_run % is not running (status=%)', p_run_id, v_run.status; end if;

  for v_cluster in select * from jsonb_array_elements(coalesce(p_clusters, '[]'::jsonb)) loop
    v_label := v_cluster ->> 'label';
    v_label_failed := coalesce((v_cluster ->> 'label_failed')::boolean, false);
    v_post_ids := v_cluster -> 'post_ids';
    if v_label is null or jsonb_typeof(v_post_ids) <> 'array' then
      raise exception 'each cluster requires a label and a post_ids array';
    end if;

    select count(*) into v_count from jsonb_array_elements_text(v_post_ids);
    if v_count = 0 then
      raise exception 'a cluster payload must not have an empty post_ids array';
    end if;

    -- Validate every post: must be in this run's own input set, must have
    -- embedding_status='embedded' (a failed input cannot be assigned to a
    -- cluster), and must not already have been assigned to an earlier
    -- cluster in this same payload (duplicate-across-clusters rejection) —
    -- all checked before any row is written.
    for v_post_id in select (elem)::uuid from jsonb_array_elements_text(v_post_ids) elem loop
      select embedding_status into v_embed_status
      from public.clustering_run_posts
      where clustering_run_id = p_run_id and raw_post_id = v_post_id;

      if v_embed_status is null then
        raise exception 'post % is not part of clustering_run %''s input set', v_post_id, p_run_id;
      end if;
      if v_embed_status <> 'embedded' then
        raise exception 'post % has embedding_status=% and cannot be assigned to a cluster', v_post_id, v_embed_status;
      end if;
      if v_post_id = any(v_seen_posts) then
        raise exception 'post % is assigned to more than one cluster in this payload', v_post_id;
      end if;
      v_seen_posts := array_append(v_seen_posts, v_post_id);
    end loop;

    -- Hard-fail if any assigned post does not have EXACTLY ONE embedding row
    -- for the run's own embedding_model — before computing anything or
    -- writing any row. A post with zero matching-model embeddings would
    -- silently skew the centroid average (fewer terms than post_count); a
    -- post with more than one would indicate a real data integrity problem
    -- upstream (the (anonymize_result_id, model) primary key on
    -- post_embeddings should already prevent this, but this is the point
    -- where it would actually matter, so it is checked explicitly here too).
    select count(*) into v_embedding_count
    from public.post_embeddings pe
    join public.clustering_run_posts crp
      on crp.anonymize_result_id = pe.anonymize_result_id and crp.clustering_run_id = p_run_id
    where crp.raw_post_id in (select (elem)::uuid from jsonb_array_elements_text(v_post_ids) elem)
      and pe.model = v_run.embedding_model;

    if v_embedding_count <> v_count then
      raise exception
        'clustering_run % (model %): expected exactly % embedding(s) for this cluster''s posts under this run''s model, found %',
        p_run_id, v_run.embedding_model, v_count, v_embedding_count;
    end if;

    -- Centroid: ONLY embeddings matching this run's own embedding_model —
    -- never averaging vectors produced by two different models together.
    select public.avg(pe.embedding) into v_centroid
    from public.post_embeddings pe
    join public.clustering_run_posts crp
      on crp.anonymize_result_id = pe.anonymize_result_id and crp.clustering_run_id = p_run_id
    where crp.raw_post_id in (select (elem)::uuid from jsonb_array_elements_text(v_post_ids) elem)
      and pe.model = v_run.embedding_model;

    insert into public.clusters (clustering_run_id, label, label_failed, centroid, post_count)
    values (p_run_id, v_label, v_label_failed, v_centroid, v_count)
    returning id into v_cluster_id;

    insert into public.cluster_assignments (cluster_id, clustering_run_id, raw_post_id)
    select v_cluster_id, p_run_id, (elem)::uuid from jsonb_array_elements_text(v_post_ids) elem;
  end loop;

  update public.clustering_runs set status = 'completed', completed_at = now() where id = p_run_id;
end
$$;

comment on function public.complete_clustering_run is
  'Phase 2 (success only). Persists clusters + assignments and marks the run completed. '
  'Every post_ids entry is validated against the run''s own recorded input set, checked for '
  'duplicates, and checked for embedding_status=''embedded'' before anything is written. '
  'Centroids are computed using only embeddings matching the run''s own embedding_model — '
  'never averaging vectors from two different models — and the function hard-fails if any '
  'assigned post does not have exactly one embedding under that model.';

create or replace function public.fail_clustering_run(p_run_id uuid, p_error_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.clustering_runs
     set status = 'failed', error_message = p_error_message, completed_at = now()
   where id = p_run_id and status = 'running';
end
$$;

comment on function public.fail_clustering_run is
  'Phase 2 (failure path) — e.g. every embedding call failed, or an unrecoverable error hit '
  'before clustering could be attempted. Marks the run failed rather than leaving it stuck '
  'at running or, worse, letting the caller fall through to reporting success.';


-- -----------------------------------------------------------------------------
-- upsert_post_embedding — one embedding write, called per (result, model)
-- needing one. Since the table's PK is (anonymize_result_id, model), an
-- "upsert" here is really just an idempotent insert — a genuinely different
-- result or model always produces a new row, never an overwrite of a
-- semantically different embedding.
-- -----------------------------------------------------------------------------
create or replace function public.upsert_post_embedding(
  p_anonymize_result_id uuid, p_raw_post_id uuid, p_embedding public.vector(1536), p_model text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.post_embeddings (anonymize_result_id, model, raw_post_id, embedding)
  values (p_anonymize_result_id, p_model, p_raw_post_id, p_embedding)
  on conflict (anonymize_result_id, model) do nothing;
end
$$;


-- =============================================================================
-- Privileges — SELECT + controlled RPCs for editors/service_role; writes to
-- the trusted tables only through the RPCs above.
-- =============================================================================
alter table public.post_embeddings     enable row level security;
alter table public.clustering_runs     enable row level security;
alter table public.clustering_run_posts enable row level security;
alter table public.clusters            enable row level security;
alter table public.cluster_assignments enable row level security;

revoke all on public.post_embeddings      from anon, authenticated;
revoke all on public.clustering_runs      from anon, authenticated;
revoke all on public.clustering_run_posts from anon, authenticated;
revoke all on public.clusters             from anon, authenticated;
revoke all on public.cluster_assignments  from anon, authenticated;

grant select on public.post_embeddings      to authenticated;
grant select on public.clustering_runs      to authenticated;
grant select on public.clustering_run_posts to authenticated;
grant select on public.clusters             to authenticated;
grant select on public.cluster_assignments  to authenticated;

grant select on public.post_embeddings      to service_role;
grant select on public.clustering_runs      to service_role;
grant select on public.clustering_run_posts to service_role;
grant select on public.clusters             to service_role;
grant select on public.cluster_assignments  to service_role;

revoke truncate, trigger, references on
  public.post_embeddings, public.clustering_runs, public.clustering_run_posts,
  public.clusters, public.cluster_assignments
  from service_role, authenticated, anon;

create policy post_embeddings_select_for_editors on public.post_embeddings
  for select to authenticated using ((select public.is_editor()));
create policy clustering_runs_select_for_editors on public.clustering_runs
  for select to authenticated using ((select public.is_editor()));
create policy clustering_run_posts_select_for_editors on public.clustering_run_posts
  for select to authenticated using ((select public.is_editor()));
create policy clusters_select_for_editors on public.clusters
  for select to authenticated using ((select public.is_editor()));
create policy cluster_assignments_select_for_editors on public.cluster_assignments
  for select to authenticated using ((select public.is_editor()));

-- RPC execute grants (service_role only).
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'create_clustering_run(timestamptz,timestamptz,numeric,numeric,integer,text)',
    'record_clustering_run_input(uuid,jsonb)',
    'record_embedding_outcome(uuid,uuid,text,text)',
    'complete_clustering_run(uuid,jsonb)',
    'fail_clustering_run(uuid,text)',
    'upsert_post_embedding(uuid,uuid,public.vector,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end
$grants$;

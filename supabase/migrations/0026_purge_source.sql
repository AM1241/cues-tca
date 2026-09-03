-- =============================================================================
-- 0026 — an admin can permanently remove a source and everything derived from it
-- =============================================================================
-- 0002 deliberately shipped with no DELETE policy on sources and no DELETE
-- grant at all: raw_posts.source_id is ON DELETE RESTRICT, so even service_role
-- had to clear the posts first, on purpose. Disabling a source
-- (`enabled = false`) has always been the intended way to retire one, and nine
-- tables read from raw_posts before this migration — scores, anonymised text,
-- embeddings, clustering, traceability — so a source with any real history is
-- load-bearing for work an editor has already produced.
--
-- The operator's request is real and distinct from "disable": a source added
-- by mistake, or one nobody wants any trace of, should be genuinely removable
-- by an admin — not just hidden forever.
--
-- The reason this needs its own function rather than a DELETE grant: the FKs
-- protecting raw_posts are a MIX of CASCADE and RESTRICT, in an order that
-- matters (verified against pg_constraint before writing this), and one
-- reference has NO foreign key at all —
-- cluster_generation_results.raw_post_ids is a plain uuid[], because an array
-- element cannot carry a FK in Postgres. That is the one Postgres cannot
-- protect on its own, and it is exactly the one that matters most: it is the
-- traceability behind copy an editor may have already approved and exported.
-- purge_source() checks it explicitly, before touching anything, and refuses
-- outright if any of the source's posts are cited by a generation result —
-- naming which ones, and whether any are approved, rather than silently
-- orphaning a citation nothing else could have stopped.
-- =============================================================================

create or replace function public.purge_source(p_source_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_name text;
  v_blocking jsonb;
  v_post_ids uuid[];
  v_counts jsonb;
  n_posts int; n_scoring_results int; n_scoring_job_state int; n_scoring_dead_letter int;
  n_anonymize_results int; n_anonymize_job_state int; n_anonymize_dead_letter int;
  n_clustering_run_posts int; n_traceability_link_posts int; n_ingest_run_sources int;
begin
  if not (select public.is_admin()) then
    raise exception 'only an admin may delete a source';
  end if;

  select name into v_source_name from public.sources where id = p_source_id;
  if v_source_name is null then
    raise exception 'source % not found', p_source_id;
  end if;

  select array_agg(id) into v_post_ids from public.raw_posts where source_id = p_source_id;
  v_post_ids := coalesce(v_post_ids, '{}');

  -- The check nothing else in the schema can make: cluster_generation_results
  -- cites posts by plain uuid[], with no FK to enforce or even notice a
  -- dangling reference. Refuse by name, not just by count, so the admin can
  -- go look rather than guess.
  select jsonb_agg(jsonb_build_object(
           'result_id', g.id, 'cluster_label', g.cluster_label,
           'kind', g.kind, 'approved',
           exists (select 1 from public.cluster_generation_reviews v
                     where v.result_id = g.id and v.status = 'approved')))
    into v_blocking
    from public.cluster_generation_results g
   where g.raw_post_ids && v_post_ids;

  if v_blocking is not null then
    raise exception
      'source "%" has % post(s) cited in generated copy and cannot be purged: %',
      v_source_name, cardinality(v_post_ids), v_blocking;
  end if;

  -- Deletion order matches the FK graph exactly (confirmed against
  -- pg_constraint, not assumed): clustering_run_posts is a RESTRICT child of
  -- BOTH raw_posts and anonymize_results, so it must go before either. Once
  -- it is gone, cluster_assignments cascades away on its own (it references
  -- clustering_run_posts, not raw_posts, with ON DELETE CASCADE).
  delete from public.clustering_run_posts where raw_post_id = any(v_post_ids);
  get diagnostics n_clustering_run_posts = row_count;

  -- anonymize_results is a RESTRICT child of raw_posts and, in turn, the
  -- parent of post_embeddings (CASCADE — follows automatically) and
  -- anonymized_posts_current.current_result_id (SET NULL — the row itself
  -- disappears a moment later anyway, when raw_posts cascades).
  delete from public.anonymize_results where raw_post_id = any(v_post_ids);
  get diagnostics n_anonymize_results = row_count;

  -- The remaining RESTRICT children of raw_posts, in no particular order
  -- relative to each other — none of them reference one another.
  delete from public.traceability_link_posts where raw_post_id = any(v_post_ids);
  get diagnostics n_traceability_link_posts = row_count;
  delete from public.scoring_results where raw_post_id = any(v_post_ids);
  get diagnostics n_scoring_results = row_count;
  delete from public.scoring_job_state where raw_post_id = any(v_post_ids);
  get diagnostics n_scoring_job_state = row_count;
  delete from public.scoring_dead_letter where raw_post_id = any(v_post_ids);
  get diagnostics n_scoring_dead_letter = row_count;
  delete from public.anonymize_job_state where raw_post_id = any(v_post_ids);
  get diagnostics n_anonymize_job_state = row_count;
  delete from public.anonymize_dead_letter where raw_post_id = any(v_post_ids);
  get diagnostics n_anonymize_dead_letter = row_count;

  -- raw_posts itself: cascades normalized_posts, analyzed_posts,
  -- anonymized_posts_current and raw_post_content_changes automatically.
  delete from public.raw_posts where source_id = p_source_id;
  get diagnostics n_posts = row_count;

  -- The two remaining RESTRICT children of sources itself.
  delete from public.ingest_run_sources where source_id = p_source_id;
  get diagnostics n_ingest_run_sources = row_count;
  -- brand_suggestions.source_id is ON DELETE CASCADE — no explicit delete needed.

  delete from public.sources where id = p_source_id;

  v_counts := jsonb_build_object(
    'source', v_source_name,
    'raw_posts', n_posts,
    'scoring_results', n_scoring_results,
    'scoring_job_state', n_scoring_job_state,
    'scoring_dead_letter', n_scoring_dead_letter,
    'anonymize_results', n_anonymize_results,
    'anonymize_job_state', n_anonymize_job_state,
    'anonymize_dead_letter', n_anonymize_dead_letter,
    'clustering_run_posts', n_clustering_run_posts,
    'traceability_link_posts', n_traceability_link_posts,
    'ingest_run_sources', n_ingest_run_sources
  );
  return v_counts;
end;
$$;

comment on function public.purge_source(uuid) is
  'Admin-only, permanent removal of a source and every row derived from its posts. '
  'Refuses outright if any of the source''s posts are cited in cluster_generation_results '
  '(a plain uuid[], not FK-enforced) — the one reference the schema cannot police on its own, '
  'and the one that would otherwise silently corrupt the traceability behind copy an editor '
  'may have already approved. Deletion order follows the FK graph in pg_constraint exactly.';

revoke all on function public.purge_source(uuid) from public, anon;
grant execute on function public.purge_source(uuid) to authenticated, service_role;

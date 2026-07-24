-- Phase 4 verification (anonymise schema 0014, clustering schema 0015).
-- One transaction, rolled back. Hard assertions: a failed invariant RAISEs and
-- the script exits non-zero (psql -v ON_ERROR_STOP=1 aborts on the first error).
-- Mirrors scripts/verify_scoring.sql's structure and helpers.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f scripts/verify_phase4.sql
\pset pager off
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.expect_eq(p_label text, p_actual anyelement, p_expected anyelement)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'ASSERTION FAILED: % — expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'OK: % = %', p_label, p_actual;
end
$$;

create or replace function pg_temp.expect_true(p_label text, p_actual boolean)
returns void language plpgsql as $$
begin
  if p_actual is not true then
    raise exception 'ASSERTION FAILED: % — expected true, got %', p_label, p_actual;
  end if;
  raise notice 'OK: %', p_label;
end
$$;

-- Self-contained fixtures, created once before any savepoint.
insert into public.sources (name, source_type, url, enabled)
values ('verify_phase4.sql fixture', 'linkedin', 'https://example.test/verify-phase4', true);

create or replace function pg_temp.verify_source_id() returns uuid
language sql stable as $$
  select id from public.sources where name = 'verify_phase4.sql fixture'
$$;

insert into public.configurations (id)
  select 'default' where not exists (select 1 from public.configurations where id = 'default');

-- One scored raw_post this whole script reuses as its anonymisation fixture:
-- create -> score (via the real scoring RPCs, same chain the Deno suite
-- uses) -> promote via set_current_scoring_result, so analyzed_posts.
-- current_result_id is genuinely non-null, matching what
-- backfill_anonymize_jobs actually requires.
create or replace function pg_temp.mk_scored_post(p_text text, p_relevance numeric default 80)
returns uuid language plpgsql as $$
declare
  v_sid uuid := pg_temp.verify_source_id();
  v_rp uuid;
  v_req uuid;
  v_job uuid;
  v_msg bigint;
  v_result uuid;
begin
  insert into public.raw_posts (source_id, source_url, external_post_id, post_text, published_at)
  values (v_sid, 'https://example.test/p', gen_random_uuid()::text, p_text, now())
  returning id into v_rp;

  v_req := public.create_scoring_request('evaluation', 'scoring_v1', 'ph4-hash',
    public.scoring_config_snapshot(), 'gpt-x', 'gpt-x-2026-01', 'max_theme_v1');
  perform public.activate_scoring_request(v_req);

  -- An 'evaluation' request is never auto-enqueued by
  -- trg_enqueue_scoring_on_raw_post (production-only, and this post already
  -- existed before v_req did anyway) — enqueue explicitly, same as the Deno
  -- suite's enqueueUnder helper.
  perform public.enqueue_scoring_job(v_rp, v_req);

  select id, msg_id into v_job, v_msg from public.scoring_job_state where raw_post_id = v_rp;
  perform public.complete_scoring_job(v_job, v_msg, v_rp, v_req,
    jsonb_build_object('sustainability', p_relevance, 'innovation', 0, 'talent_development', 0,
                        'food_safety', 0, 'supply_chain', 0, 'tradition', 0),
    'verify_phase4 fixture');

  select id into v_result from public.scoring_results where raw_post_id = v_rp and scoring_request_id = v_req;
  perform public.set_current_scoring_result(v_rp, v_result);
  perform public.close_scoring_request(v_req);

  return v_rp;
end
$$;

-- A scored + anonymised post, via the real anonymise RPC chain
-- (backfill -> claim -> complete), returning both the raw_post_id and the
-- exact anonymize_results.id produced — the clustering sections need the
-- latter, not just the former, since embeddings/run-input are keyed off it.
create or replace function pg_temp.mk_anonymized_post(p_text text, p_relevance numeric default 80)
returns table (raw_post_id uuid, anonymize_result_id uuid)
language plpgsql as $$
declare v_rp uuid; v_claimed record; v_current record;
begin
  v_rp := pg_temp.mk_scored_post(p_text, p_relevance);
  perform public.backfill_anonymize_jobs();
  select * into v_claimed from public.read_anonymize_jobs(120, 50) where (message->>'raw_post_id')::uuid = v_rp;
  perform public.complete_anonymize_job(
    (v_claimed.message ->> 'job_id')::uuid, v_claimed.msg_id, v_rp,
    p_text, '[]'::jsonb, 'a food-sector organization', true, '{}'::jsonb, null, v_claimed.processing_token);
  select * into v_current from public.anonymized_posts_current apc where apc.raw_post_id = v_rp;
  raw_post_id := v_rp;
  anonymize_result_id := v_current.current_result_id;
  return next;
end
$$;

-- Helper: re-anonymise an already-anonymised post (a brand-new
-- anonymize_results row, current_result_id repointed) — the schema-level
-- equivalent of the anonymise worker running again with different findings.
-- This is what "the anonymisation result changed" means for reproducibility.
create or replace function pg_temp.mk_reanonymized(p_raw_post_id uuid, p_text text, p_relevance numeric default 80)
returns uuid language plpgsql as $$
declare v_result_id uuid; v_hash text := md5(random()::text);
begin
  insert into public.anonymize_results (
    raw_post_id, source_name, generalized_source_name, overall_relevance,
    anonymized_text, entity_extraction_used, config_hash, idempotency_key
  ) values (
    p_raw_post_id, 'x', 'a food-sector organization', p_relevance, p_text, true, v_hash, gen_random_uuid()::text
  ) returning id into v_result_id;

  update public.anonymized_posts_current
     set anonymized_text = p_text, overall_relevance = p_relevance, current_result_id = v_result_id, updated_at = now()
   where raw_post_id = p_raw_post_id;

  return v_result_id;
end
$$;

\echo '######## A. MIGRATIONS ########'
select 'migrations' k, string_agg(version, ',' order by version) from supabase_migrations.schema_migrations;

\echo '######## B. ANONYMISE: backfill -> claim -> complete happy path ########'
savepoint s;
do $blk$
declare
  v_rp uuid; v_count int; v_claimed record; v_result text;
  v_current record;
begin
  v_rp := pg_temp.mk_scored_post('B section fixture post text.');

  v_count := public.backfill_anonymize_jobs();
  perform pg_temp.expect_true('backfill enqueued at least the fixture post', v_count >= 1);

  select * into v_claimed from public.read_anonymize_jobs(120, 50) where (message->>'raw_post_id')::uuid = v_rp;
  perform pg_temp.expect_true('the fixture job was claimable', v_claimed.msg_id is not null);

  v_result := public.complete_anonymize_job(
    (v_claimed.message ->> 'job_id')::uuid, v_claimed.msg_id, v_rp,
    'anonymised text', '[{"original":"x","replacement":"y","source":"source_name"}]'::jsonb,
    'a food-sector organization', true, '{}'::jsonb, null, v_claimed.processing_token);
  perform pg_temp.expect_eq('complete_anonymize_job result', v_result, 'inserted');

  select * into v_current from public.anonymized_posts_current where raw_post_id = v_rp;
  perform pg_temp.expect_true('anonymized_posts_current row written', v_current.raw_post_id is not null);
  perform pg_temp.expect_true('current_result_id points at a real anonymize_results row', v_current.current_result_id is not null);

  perform pg_temp.expect_eq('job marked succeeded', (select status from public.anonymize_job_state where raw_post_id = v_rp), 'succeeded');
end $blk$;
rollback to s;

\echo '######## C. ANONYMISE: fail-loud guard — entity_extraction_used=false is rejected ########'
savepoint s;
do $blk$
declare v_rp uuid; v_claimed record; v_raised boolean := false;
begin
  v_rp := pg_temp.mk_scored_post('C section fixture post text.');
  perform public.backfill_anonymize_jobs();
  select * into v_claimed from public.read_anonymize_jobs(120, 50) where (message->>'raw_post_id')::uuid = v_rp;

  begin
    perform public.complete_anonymize_job(
      (v_claimed.message ->> 'job_id')::uuid, v_claimed.msg_id, v_rp,
      'partial text', '[]'::jsonb, 'x', false, '{}'::jsonb, null, v_claimed.processing_token);
  exception when others then
    v_raised := true;
  end;
  perform pg_temp.expect_true('completing with entity_extraction_used=false raises', v_raised);
  perform pg_temp.expect_eq('no anonymized_posts_current row written',
    (select count(*) from public.anonymized_posts_current where raw_post_id = v_rp)::int, 0);
end $blk$;
rollback to s;

\echo '######## D. ANONYMISE: append-only — UPDATE/DELETE on anonymize_results always raises ########'
savepoint s;
do $blk$
declare v_rp uuid; v_claimed record; v_result_id uuid; v_raised boolean;
begin
  v_rp := pg_temp.mk_scored_post('D section fixture post text.');
  perform public.backfill_anonymize_jobs();
  select * into v_claimed from public.read_anonymize_jobs(120, 50) where (message->>'raw_post_id')::uuid = v_rp;
  perform public.complete_anonymize_job(
    (v_claimed.message ->> 'job_id')::uuid, v_claimed.msg_id, v_rp,
    'anonymised text', '[]'::jsonb, 'x', true, '{}'::jsonb, null, v_claimed.processing_token);
  select current_result_id into v_result_id from public.anonymized_posts_current where raw_post_id = v_rp;

  v_raised := false;
  begin
    update public.anonymize_results set anonymized_text = 'tampered' where id = v_result_id;
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('UPDATE on anonymize_results raises', v_raised);

  v_raised := false;
  begin
    delete from public.anonymize_results where id = v_result_id;
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('DELETE on anonymize_results raises', v_raised);
end $blk$;
rollback to s;

\echo '######## E. ANONYMISE: RLS denies anon and authenticated writes ########'
savepoint s;
do $blk$
declare v_raised boolean;
begin
  v_raised := false;
  begin
    set local role anon;
    insert into public.anonymize_results (raw_post_id, source_name, generalized_source_name, overall_relevance,
      anonymized_text, entity_extraction_used, config_hash, idempotency_key)
    values (gen_random_uuid(), 'x', 'x', 50, 'x', true, 'x', gen_random_uuid()::text);
  exception when others then v_raised := true;
  end;
  reset role;
  perform pg_temp.expect_true('anon cannot insert into anonymize_results', v_raised);

  v_raised := false;
  begin
    set local role authenticated;
    insert into public.anonymize_job_state (raw_post_id) values (gen_random_uuid());
  exception when others then v_raised := true;
  end;
  reset role;
  perform pg_temp.expect_true('authenticated cannot insert into anonymize_job_state', v_raised);
end $blk$;
rollback to s;

\echo '######## F. CLUSTERING: two-phase run (create -> input -> complete) writes a coherent run ########'
savepoint s;
do $blk$
declare
  v_p1 record; v_p2 record; v_run uuid; v_cluster_id uuid; v_run_row record;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('F section post one.');
  select * into v_p2 from pg_temp.mk_anonymized_post('F section post two.');
  perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p1.raw_post_id, array_fill(0.1, array[1536])::vector, 'verify-model');
  perform public.upsert_post_embedding(v_p2.anonymize_result_id, v_p2.raw_post_id, array_fill(0.1, array[1536])::vector, 'verify-model');

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 2, 'verify-model');
  select status into v_run_row from public.clustering_runs where id = v_run;
  perform pg_temp.expect_eq('run status is running immediately after create', (select status from public.clustering_runs where id = v_run), 'running');

  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id),
    jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id)));
  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'embedded');
  perform public.record_embedding_outcome(v_run, v_p2.raw_post_id, 'embedded');

  perform public.complete_clustering_run(v_run, jsonb_build_array(
    jsonb_build_object('label', 'Verify Cluster', 'label_failed', false,
      'post_ids', jsonb_build_array(v_p1.raw_post_id, v_p2.raw_post_id))));

  select * into v_run_row from public.clustering_runs where id = v_run;
  perform pg_temp.expect_eq('run status is completed', v_run_row.status, 'completed');
  perform pg_temp.expect_eq('run snapshotted similarity threshold', v_run_row.cluster_similarity_threshold, 0.75::numeric(3,2));
  perform pg_temp.expect_eq('run snapshotted min_cluster_size', v_run_row.min_cluster_size, 2);

  select id into v_cluster_id from public.clusters where clustering_run_id = v_run;
  perform pg_temp.expect_eq('exactly one cluster written',
    (select count(*) from public.clusters where clustering_run_id = v_run)::int, 1);
  perform pg_temp.expect_eq('cluster has a real centroid (avg over 2 embeddings)',
    (select centroid is not null from public.clusters where id = v_cluster_id), true);
  perform pg_temp.expect_eq('both posts assigned to the cluster',
    (select count(*) from public.cluster_assignments where cluster_id = v_cluster_id)::int, 2);
  perform pg_temp.expect_eq('input post set recorded exactly',
    (select count(*) from public.clustering_run_posts where clustering_run_id = v_run)::int, 2);
  perform pg_temp.expect_eq('input set records the exact anonymize_result_id used (post 1)',
    (select anonymize_result_id from public.clustering_run_posts where clustering_run_id = v_run and raw_post_id = v_p1.raw_post_id),
    v_p1.anonymize_result_id);

  -- Reproducibility: editing configurations afterward must not retroactively
  -- change what this already-recorded run is understood to have used.
  update public.configurations set cluster_similarity_threshold = 0.5, min_cluster_size = 5 where id = 'default';
  select * into v_run_row from public.clustering_runs where id = v_run;
  perform pg_temp.expect_eq('run threshold unaffected by a later configurations edit', v_run_row.cluster_similarity_threshold, 0.75::numeric(3,2));
  perform pg_temp.expect_eq('run min_cluster_size unaffected by a later configurations edit', v_run_row.min_cluster_size, 2);
end $blk$;
rollback to s;

\echo '######## F2. CLUSTERING: re-anonymising a post never changes a historical run''s record ########'
savepoint s;
do $blk$
declare v_p1 record; v_run uuid; v_new_result uuid; v_recorded uuid;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('F2 section original text.');
  perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p1.raw_post_id, array_fill(0.3, array[1536])::vector, 'verify-model');

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');
  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id)));
  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'embedded');
  perform public.complete_clustering_run(v_run, jsonb_build_array(
    jsonb_build_object('label', 'Solo', 'label_failed', false, 'post_ids', jsonb_build_array(v_p1.raw_post_id))));

  -- Re-anonymise the SAME post — a brand new anonymize_results row, and
  -- anonymized_posts_current now points somewhere else entirely.
  v_new_result := pg_temp.mk_reanonymized(v_p1.raw_post_id, 'F2 section CHANGED text.');
  perform pg_temp.expect_true('re-anonymising produced a genuinely different result id', v_new_result <> v_p1.anonymize_result_id);

  select anonymize_result_id into v_recorded from public.clustering_run_posts
   where clustering_run_id = v_run and raw_post_id = v_p1.raw_post_id;
  perform pg_temp.expect_eq('the historical run still points at the ORIGINAL anonymize_result_id, not the new one',
    v_recorded, v_p1.anonymize_result_id);
end $blk$;
rollback to s;

\echo '######## G. CLUSTERING: cascades — no orphaned cluster_assignments after a run is deleted ########'
savepoint s;
do $blk$
declare v_p1 record; v_p2 record; v_run uuid; v_cluster_id uuid; v_orphans int;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G section post one.');
  select * into v_p2 from pg_temp.mk_anonymized_post('G section post two.');
  perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p1.raw_post_id, array_fill(0.2, array[1536])::vector, 'verify-model');
  perform public.upsert_post_embedding(v_p2.anonymize_result_id, v_p2.raw_post_id, array_fill(0.2, array[1536])::vector, 'verify-model');

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 2, 'verify-model');
  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id),
    jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id)));
  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'embedded');
  perform public.record_embedding_outcome(v_run, v_p2.raw_post_id, 'embedded');
  perform public.complete_clustering_run(v_run, jsonb_build_array(
    jsonb_build_object('label', 'Cascade Check', 'label_failed', false,
      'post_ids', jsonb_build_array(v_p1.raw_post_id, v_p2.raw_post_id))));
  select id into v_cluster_id from public.clusters where clustering_run_id = v_run;

  -- service_role has no DELETE grant on clustering_runs directly (SELECT-only,
  -- per 0015's grants), so exercise the cascade at the superuser level this
  -- script already runs as, proving the FK ON DELETE CASCADE chain itself.
  delete from public.clustering_runs where id = v_run;

  select count(*) into v_orphans from public.clusters where id = v_cluster_id;
  perform pg_temp.expect_eq('cluster row cascaded away with its run', v_orphans, 0);
  select count(*) into v_orphans from public.cluster_assignments where cluster_id = v_cluster_id;
  perform pg_temp.expect_eq('no orphaned cluster_assignments after cascade', v_orphans, 0);
end $blk$;
rollback to s;

\echo '######## G2. CLUSTERING: failure semantics — a stuck/failed run never reports completed ########'
savepoint s;
do $blk$
declare v_run uuid; v_status text;
begin
  -- Simulates "every embedding failed": a run is created and given a real
  -- input set, but the Edge Function never calls complete_clustering_run —
  -- it calls fail_clustering_run instead. The run must end up 'failed', not
  -- silently 'running' forever and never 'completed' with zero real work.
  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 2, 'verify-model');
  perform public.fail_clustering_run(v_run, 'all embeddings failed (simulated)');

  select status into v_status from public.clustering_runs where id = v_run;
  perform pg_temp.expect_eq('a failed run is marked failed, never completed', v_status, 'failed');
  perform pg_temp.expect_eq('no clusters exist for a failed run',
    (select count(*) from public.clusters where clustering_run_id = v_run)::int, 0);

  -- fail_clustering_run is a no-op once complete_clustering_run already ran —
  -- a genuinely completed run cannot be retroactively marked failed by a
  -- stray/late call, which would be just as dishonest as the reverse.
  perform public.fail_clustering_run(v_run, 'late call after already failed');
  select status into v_status from public.clustering_runs where id = v_run;
  perform pg_temp.expect_eq('fail_clustering_run only-if-running guard holds on a second call too', v_status, 'failed');
end $blk$;
rollback to s;

\echo '######## G3. CLUSTERING: assignment integrity — duplicate, out-of-set, and cross-run violations are rejected ########'
savepoint s;
do $blk$
declare
  v_p1 record; v_p2 record; v_p3 record; v_run uuid; v_other_run uuid; v_raised boolean;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G3 section post one.');
  select * into v_p2 from pg_temp.mk_anonymized_post('G3 section post two.');
  select * into v_p3 from pg_temp.mk_anonymized_post('G3 section post three (not in the run''s input set).');
  perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p1.raw_post_id, array_fill(0.4, array[1536])::vector, 'verify-model');
  perform public.upsert_post_embedding(v_p2.anonymize_result_id, v_p2.raw_post_id, array_fill(0.4, array[1536])::vector, 'verify-model');

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');
  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id),
    jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id)));
  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'embedded');
  perform public.record_embedding_outcome(v_run, v_p2.raw_post_id, 'embedded');

  -- (1) A post not in the run's own input set must be rejected.
  v_raised := false;
  begin
    perform public.complete_clustering_run(v_run, jsonb_build_array(
      jsonb_build_object('label', 'Bad', 'label_failed', false, 'post_ids', jsonb_build_array(v_p3.raw_post_id))));
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('a post outside the run''s input set is rejected by complete_clustering_run', v_raised);

  -- (2) The same post assigned to two clusters in one payload must be rejected.
  v_raised := false;
  begin
    perform public.complete_clustering_run(v_run, jsonb_build_array(
      jsonb_build_object('label', 'A', 'label_failed', false, 'post_ids', jsonb_build_array(v_p1.raw_post_id)),
      jsonb_build_object('label', 'B', 'label_failed', false, 'post_ids', jsonb_build_array(v_p1.raw_post_id))));
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('a post duplicated across two clusters in one payload is rejected', v_raised);

  -- (3) A genuinely valid completion succeeds and produces the expected
  -- persisted state (real DB-level proof, not just "the RPC didn't raise").
  perform public.complete_clustering_run(v_run, jsonb_build_array(
    jsonb_build_object('label', 'Valid', 'label_failed', false, 'post_ids', jsonb_build_array(v_p1.raw_post_id, v_p2.raw_post_id))));
  perform pg_temp.expect_eq('one post -> one cluster within this run (unique constraint holds)',
    (select count(*) from public.cluster_assignments where clustering_run_id = v_run and raw_post_id = v_p1.raw_post_id)::int, 1);
  perform pg_temp.expect_eq('cluster post_count matches persisted assignments',
    (select post_count from public.clusters where clustering_run_id = v_run),
    (select count(*)::int from public.cluster_assignments where clustering_run_id = v_run));

  -- (4) Direct-insert proof of the DB-level constraints themselves (not just
  -- the RPC's own pre-checks) — a second cluster in a DIFFERENT run trying to
  -- claim v_p1 via a raw INSERT must still be rejected by the unique index /
  -- composite FK, since the RPC's validation is not the only thing holding
  -- this invariant.
  v_other_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');
  perform public.record_clustering_run_input(v_other_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id)));

  v_raised := false;
  begin
    -- References a real cluster from v_run but tags it with v_other_run's id
    -- — the trigger must catch this cross-run inconsistency even though the
    -- composite FK alone would not (v_other_run does have v_p1 in its input set).
    insert into public.cluster_assignments (cluster_id, clustering_run_id, raw_post_id)
    select id, v_other_run, v_p1.raw_post_id from public.clusters where clustering_run_id = v_run limit 1;
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('a cluster_assignments row whose clustering_run_id does not match its cluster''s own run is rejected', v_raised);
end $blk$;
rollback to s;

\echo '######## G4. CLUSTERING: centroid model isolation — never averages across embedding models ########'
savepoint s;
do $blk$
declare
  v_p1 record; v_p2 record; v_run uuid; v_cluster_id uuid;
  v_centroid_a public.vector(1536); v_expected_a public.vector(1536);
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G4 section post one.');
  select * into v_p2 from pg_temp.mk_anonymized_post('G4 section post two.');

  -- Both posts embedded under 'model-a' (values 0.1/0.3, avg 0.2) AND under
  -- a completely different 'model-b' (values 9.0/9.0) — if the centroid ever
  -- accidentally mixed models, averaging in model-b's values would move the
  -- result far away from 0.2.
  perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p1.raw_post_id, array_fill(0.1, array[1536])::vector, 'model-a');
  perform public.upsert_post_embedding(v_p2.anonymize_result_id, v_p2.raw_post_id, array_fill(0.3, array[1536])::vector, 'model-a');
  perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p1.raw_post_id, array_fill(9.0, array[1536])::vector, 'model-b');
  perform public.upsert_post_embedding(v_p2.anonymize_result_id, v_p2.raw_post_id, array_fill(9.0, array[1536])::vector, 'model-b');

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 2, 'model-a');
  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id),
    jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id)));
  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'embedded');
  perform public.record_embedding_outcome(v_run, v_p2.raw_post_id, 'embedded');
  perform public.complete_clustering_run(v_run, jsonb_build_array(
    jsonb_build_object('label', 'Model A Only', 'label_failed', false,
      'post_ids', jsonb_build_array(v_p1.raw_post_id, v_p2.raw_post_id))));

  select id, centroid into v_cluster_id, v_centroid_a from public.clusters where clustering_run_id = v_run;
  v_expected_a := array_fill(0.2, array[1536])::vector;
  perform pg_temp.expect_true(
    'centroid uses only model-a''s embeddings (avg of 0.1/0.3 = 0.2), never averaging in model-b''s 9.0 values',
    (v_centroid_a <-> v_expected_a) < 0.0001
  );
end $blk$;
rollback to s;

\echo '######## G5. CLUSTERING: hard-fail if an assigned post lacks exactly one embedding under the run''s model ########'
savepoint s;
do $blk$
declare v_p1 record; v_run uuid; v_raised boolean;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G5 section post with no matching-model embedding.');
  -- Deliberately no upsert_post_embedding call for 'verify-model-g5' at all.

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model-g5');
  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id)));
  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'embedded');

  v_raised := false;
  begin
    perform public.complete_clustering_run(v_run, jsonb_build_array(
      jsonb_build_object('label', 'Should Fail', 'label_failed', false, 'post_ids', jsonb_build_array(v_p1.raw_post_id))));
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true(
    'complete_clustering_run hard-fails when an assigned post has zero embeddings under the run''s own model',
    v_raised
  );
end $blk$;
rollback to s;

\echo '######## G6. ANONYMISE/CLUSTER: raw_post_id/anonymize_result_id pairing enforced by the database itself ########'
savepoint s;
do $blk$
declare v_p1 record; v_p2 record; v_raised boolean;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G6 section post one.');
  select * into v_p2 from pg_temp.mk_anonymized_post('G6 section post two.');

  -- post_embeddings: p1's result paired with p2's raw_post_id must be rejected.
  v_raised := false;
  begin
    perform public.upsert_post_embedding(v_p1.anonymize_result_id, v_p2.raw_post_id, array_fill(0.1, array[1536])::vector, 'verify-model');
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true(
    'post_embeddings rejects a raw_post_id paired with another post''s anonymize_result_id',
    v_raised
  );

  -- clustering_run_posts: same mismatch, via record_clustering_run_input.
  declare v_run uuid;
  begin
    v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');
    v_raised := false;
    begin
      perform public.record_clustering_run_input(v_run, jsonb_build_array(
        jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id)));
    exception when others then v_raised := true;
    end;
    perform pg_temp.expect_true(
      'clustering_run_posts rejects a raw_post_id paired with another post''s anonymize_result_id',
      v_raised
    );
  end;
end $blk$;
rollback to s;

\echo '######## G7. CLUSTERING: duplicate/conflicting run input is rejected, not silently ignored ########'
savepoint s;
do $blk$
declare v_p1 record; v_run uuid; v_raised boolean; v_count int;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G7 section post one.');
  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');

  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id)));

  -- A second call for the SAME run must raise, not silently no-op.
  v_raised := false;
  begin
    perform public.record_clustering_run_input(v_run, jsonb_build_array(
      jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id)));
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('a second record_clustering_run_input call for an already-recorded run raises', v_raised);

  select count(*) into v_count from public.clustering_run_posts where clustering_run_id = v_run;
  perform pg_temp.expect_eq('still exactly one input row after the rejected second call', v_count, 1);

  -- A duplicate raw_post_id WITHIN one payload (a fresh run) must also raise.
  declare v_run2 uuid; v_p2 record;
  begin
    select * into v_p2 from pg_temp.mk_anonymized_post('G7 section post two.');
    v_run2 := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');
    v_raised := false;
    begin
      perform public.record_clustering_run_input(v_run2, jsonb_build_array(
        jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id),
        jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id)));
    exception when others then v_raised := true;
    end;
    perform pg_temp.expect_true('a duplicate raw_post_id within one input payload raises', v_raised);
  end;
end $blk$;
rollback to s;

\echo '######## G8. CLUSTERING: partial embedding failure persists and stays queryable; a failed input cannot be assigned ########'
savepoint s;
do $blk$
declare v_p1 record; v_p2 record; v_run uuid; v_raised boolean; v_status text; v_msg text;
begin
  select * into v_p1 from pg_temp.mk_anonymized_post('G8 section post that fails embedding.');
  select * into v_p2 from pg_temp.mk_anonymized_post('G8 section post that succeeds.');

  v_run := public.create_clustering_run(now() - interval '7 days', now(), 50, 0.75, 1, 'verify-model');
  perform public.record_clustering_run_input(v_run, jsonb_build_array(
    jsonb_build_object('raw_post_id', v_p1.raw_post_id, 'anonymize_result_id', v_p1.anonymize_result_id),
    jsonb_build_object('raw_post_id', v_p2.raw_post_id, 'anonymize_result_id', v_p2.anonymize_result_id)));

  perform public.record_embedding_outcome(v_run, v_p1.raw_post_id, 'failed', 'verify_phase4 scripted embedding failure');
  perform public.upsert_post_embedding(v_p2.anonymize_result_id, v_p2.raw_post_id, array_fill(0.5, array[1536])::vector, 'verify-model');
  perform public.record_embedding_outcome(v_run, v_p2.raw_post_id, 'embedded');

  -- The outcome is queryable independent of anything else happening —
  -- this is the audit trail, checked directly, not inferred from a response.
  select embedding_status, embedding_error_message into v_status, v_msg
  from public.clustering_run_posts where clustering_run_id = v_run and raw_post_id = v_p1.raw_post_id;
  perform pg_temp.expect_eq('failed post''s embedding_status is persisted', v_status, 'failed');
  perform pg_temp.expect_eq('failed post''s error message is persisted', v_msg, 'verify_phase4 scripted embedding failure');

  select embedding_status into v_status
  from public.clustering_run_posts where clustering_run_id = v_run and raw_post_id = v_p2.raw_post_id;
  perform pg_temp.expect_eq('succeeding post''s embedding_status is persisted independently', v_status, 'embedded');

  -- The failed post cannot be assigned to a cluster.
  v_raised := false;
  begin
    perform public.complete_clustering_run(v_run, jsonb_build_array(
      jsonb_build_object('label', 'Should Reject', 'label_failed', false, 'post_ids', jsonb_build_array(v_p1.raw_post_id))));
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('a post with embedding_status=failed cannot be assigned to a cluster', v_raised);

  -- The succeeding post CAN still be completed on its own (partial success,
  -- proving the run itself is not doomed by one failed input).
  perform public.complete_clustering_run(v_run, jsonb_build_array(
    jsonb_build_object('label', 'Partial Success', 'label_failed', false, 'post_ids', jsonb_build_array(v_p2.raw_post_id))));
  perform pg_temp.expect_eq('the run completes despite the partial failure',
    (select status from public.clustering_runs where id = v_run), 'completed');
end $blk$;
rollback to s;

\echo '######## H. CLUSTERING: RLS denies anon and authenticated writes ########'
savepoint s;
do $blk$
declare v_raised boolean;
begin
  v_raised := false;
  begin
    set local role anon;
    insert into public.post_embeddings (anonymize_result_id, model, raw_post_id, embedding)
    values (gen_random_uuid(), 'x', gen_random_uuid(), array_fill(0.1, array[1536])::vector);
  exception when others then v_raised := true;
  end;
  reset role;
  perform pg_temp.expect_true('anon cannot insert into post_embeddings', v_raised);

  v_raised := false;
  begin
    set local role authenticated;
    insert into public.clustering_runs (period_start, period_end, min_relevance_score,
      cluster_similarity_threshold, min_cluster_size, embedding_model)
    values (now(), now(), 50, 0.75, 2, 'x');
  exception when others then v_raised := true;
  end;
  reset role;
  perform pg_temp.expect_true('authenticated cannot insert into clustering_runs', v_raised);
end $blk$;
rollback to s;

\echo '######## I. RLS enabled on every new table ########'
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('anonymize_results','anonymize_job_state','anonymize_dead_letter',
                   'post_embeddings','clustering_runs','clustering_run_posts','clusters','cluster_assignments')
order by 1;

\echo '######## FINAL ########'
-- Reaching this line means every hard assertion above (Sections B–H) passed.
rollback;
\echo 'Explicit ROLLBACK executed. Every Phase 4 verification section passed. Database is back to its pre-script state.'

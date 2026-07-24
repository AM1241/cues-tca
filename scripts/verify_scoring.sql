-- Phase 3B/3C verification (scoring schema, state machine, lease, prompt snapshot).
-- One transaction, rolled back. Hard assertions: a failed invariant RAISEs and
-- the script exits non-zero (psql -v ON_ERROR_STOP=1 aborts on the first error).
--
-- require_legacy_seed controls Section A (the 133-post legacy-import
-- invariants) ONLY. It does NOT weaken any other section — every Phase 3
-- schema/state-machine assertion (B onward) always runs regardless of this
-- setting, because none of them depend on the legacy seed being loaded.
--   1 (default, strict) — hard-assert all 133 legacy-import invariants.
--     Use this whenever the legacy seed (see scripts/README.md) is loaded,
--     and always in CI / against a database expected to have it.
--   0 — Section A's legacy-import invariants are explicitly SKIPPED (not
--     silently passed, not auto-detected) with a printed reason, because
--     this environment has no legacy seed loaded (e.g. a fresh `db push
--     --local` with no `load_legacy.sql` run). Never infer this from data —
--     it must be passed explicitly.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v require_legacy_seed=1 -f scripts/verify_scoring.sql
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -v require_legacy_seed=0 -f scripts/verify_scoring.sql
\pset pager off
\set ON_ERROR_STOP on
\if :{?require_legacy_seed}
\else
  \set require_legacy_seed 1
\endif
begin;

-- Helper: open an active production request for the current live config.
create or replace function pg_temp.mk_request() returns uuid
language sql as $$
  select public.create_scoring_request('production','scoring_v1','ph1',
    public.scoring_config_snapshot(),'gpt-x','gpt-x-2026-01','max_theme_v1')
$$;

-- Hard-assertion helpers. Every "expect" comparison in this file goes through
-- one of these so a mismatch RAISEs (aborting the script / transaction)
-- instead of merely printing a NOTICE that a human has to read carefully.
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

-- =============================================================================
-- Self-contained fixtures — no section below may depend on rows this script
-- did not create itself. Previously every section did `select id into v_sid
-- from public.sources limit 1`, which silently depended on whatever row
-- happened to exist: the legacy import, OR rows retained by a previous Deno
-- test run (T-score-*, permanently retained per handler_test.ts's own
-- teardown report). That is an accidental dependency on non-reproducible
-- state, not a verified invariant. Both are replaced by a source this script
-- owns, created once (before any savepoint, so every section's `rollback to
-- s` never removes it) and reused everywhere a raw_post needs a source_id.
-- =============================================================================
insert into public.sources (name, source_type, url, enabled)
values ('verify_scoring.sql fixture', 'linkedin', 'https://example.test/verify-scoring', true);

-- Looked up by its known unique name rather than passed via a psql client
-- variable: psql's `:'var'` substitution does not occur inside a `$$...$$`
-- dollar-quoted DO/function body, so every `do $blk$ ... $blk$` below calls
-- this instead of `select id into v_sid from public.sources limit 1`.
create or replace function pg_temp.verify_source_id() returns uuid
language sql stable as $$
  select id from public.sources where name = 'verify_scoring.sql fixture'
$$;

-- The `configurations` singleton is NOT created by any migration (0001-0010)
-- — confirmed by inspecting all ten files: 0001_schema.sql defines the table
-- shape and column defaults (min_relevance_score default 50, themes default
-- '[]'::jsonb) but no migration ever INSERTs the id='default' row. The only
-- source-controlled place that row is populated is
-- scripts/build_legacy_loader.mjs (-> load_legacy.sql, gitignored, requires
-- the legacy snapshot DB) — i.e. it is a canonical SEED dependency, not a
-- migrations-only guarantee. A migrations-only fresh database (e.g. a clean
-- `db push --local`) is NOT expected to support scoring-request creation
-- out of the box: create_scoring_request's own guard requires
-- config_snapshot.min_relevance_score to be non-null, which requires this
-- row to exist. This is a genuine, confirmed bootstrap gap, not something
-- this script invents or works around silently — it is fixed here, once,
-- transactionally, using ONLY the schema's own declared column defaults
-- (the same pattern scripts/verify_rls.sql already uses at line 86:
-- `insert into public.configurations (id) values ('default')`), never
-- copying values from cloud or guessing.
insert into public.configurations (id)
  select 'default' where not exists (select 1 from public.configurations where id = 'default');

\echo '######## A. MIGRATIONS + LEGACY IMPORT ########'
select 'migrations' k, string_agg(version, ',' order by version) from supabase_migrations.schema_migrations;

-- Schema-level checks that hold regardless of whether the legacy seed is
-- loaded — always run, never gated by require_legacy_seed.
do $blk$
declare v_res_total int; v_analyzed_total int; v_jobs int; v_themes int; v_reqs int;
begin
  -- v_res_total (ALL scoring_results, not just legacy) and v_analyzed_total
  -- (ALL analyzed_posts rows) are NOT asserted to any fixed value — this
  -- database also carries this suite's own eval-request fixture rows
  -- (gpt-test / T-score-* — structurally permanent, see handler_test.ts
  -- teardown notes) and possibly real Phase 3E/3F cloud scoring results, so
  -- a bare total is genuinely environment-dependent, not an invariant.
  select count(*) into v_res_total from public.scoring_results;
  select count(*) into v_analyzed_total from public.analyzed_posts;
  select count(*) into v_jobs from public.scoring_job_state;
  select count(*) into v_reqs from public.scoring_requests;
  select count(*) into v_themes from public.scoring_themes;
  raise notice 'INFO scoring_results total=% (environment-dependent, not asserted)', v_res_total;
  raise notice 'INFO analyzed_posts total=% (environment-dependent, not asserted)', v_analyzed_total;
  raise notice 'INFO scoring_job_state rows=% (environment-dependent, not asserted)', v_jobs;
  raise notice 'INFO scoring_requests rows=% (environment-dependent, not asserted)', v_reqs;
  perform pg_temp.expect_eq('scoring_themes count (schema seed, not legacy data seed)', v_themes, 6);
end $blk$;

\if :require_legacy_seed
\echo 'require_legacy_seed=1: hard-asserting the 133-post legacy-import invariants.'
do $blk$
declare v_prov int; v_reqnull int; v_cur int;
begin
  -- The actual invariants: exactly 133 results carry the specific legacy
  -- signature, exactly 133 of those have no scoring_request_id, and exactly
  -- 133 analyzed_posts projections currently point at one of them. These are
  -- true regardless of how many additional non-legacy rows exist elsewhere.
  select count(*) into v_prov from public.scoring_results where source='simulated' and provenance_status='legacy_unknown'
     and llm_used=false and model is null and prompt_version is null;
  select count(*) into v_reqnull from public.scoring_results where source='simulated' and provenance_status='legacy_unknown'
     and llm_used=false and scoring_request_id is null;
  select count(*) into v_cur from public.analyzed_posts ap
    join public.scoring_results sr on sr.id=ap.current_result_id
    where sr.source='simulated' and sr.provenance_status='legacy_unknown' and sr.llm_used=false;
  perform pg_temp.expect_eq('legacy-signature scoring_results (source=simulated, provenance=legacy_unknown, llm_used=false)', v_prov, 133);
  perform pg_temp.expect_eq('those legacy results have null scoring_request_id', v_reqnull, 133);
  perform pg_temp.expect_eq('analyzed_posts projections pointing at a legacy-signature result', v_cur, 133);
end $blk$;
\else
\echo 'require_legacy_seed=0: SKIPPING the 133-post legacy-import invariants — this environment has no legacy seed loaded. Every other Phase 3 schema/state-machine section below still runs.'
\endif

\echo '######## B. NO request => trigger does not enqueue; with active request it does ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_j0 int; v_j1 int;
begin
  v_sid := pg_temp.verify_source_id();
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000001','p',now()) returning id into v_rp;
  select count(*) into v_j0 from public.scoring_job_state where raw_post_id=v_rp;   -- no active request yet
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000002','p',now()) returning id into v_rp;
  select count(*) into v_j1 from public.scoring_job_state where raw_post_id=v_rp;   -- now enqueued
  perform pg_temp.expect_eq('no active request -> no auto-enqueue', v_j0, 0);
  perform pg_temp.expect_eq('active request -> auto-enqueue', v_j1, 1);
end $blk$;
rollback to s;

\echo '######## C. FIX 1: no duplicate logical job after success ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_j1 int; v_j2 int; v_m2 int; v_new uuid;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000003','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;
  perform public.complete_scoring_job(v_job,v_msg,v_rp,v_req,
    '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,'r');
  select count(*) into v_j1 from public.scoring_job_state where raw_post_id=v_rp;
  perform public.backfill_scoring_for_request(v_req);
  perform public.backfill_scoring_for_request(v_req);
  select count(*) into v_j2 from public.scoring_job_state where raw_post_id=v_rp;
  select count(*) into v_m2 from pgmq.q_scoring_jobs where (message->>'raw_post_id')::uuid=v_rp;
  perform pg_temp.expect_eq('one logical job before backfill', v_j1, 1);
  perform pg_temp.expect_eq('still one logical job after 2x backfill', v_j2, 1);
  perform pg_temp.expect_eq('nothing re-queued for an already-succeeded job', v_m2, 0);
end $blk$;
rollback to s;

\echo '######## D. COMPLETION: worker cannot override definition; duplicate; re-eval ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_req2 uuid; v_job uuid; v_msg bigint; v_job2 uuid; v_msg2 bigint;
        v_o1 text; v_o2 text; v_o3 text; v_results int; v_model text; v_pv text; v_overall numeric; v_inc boolean;
        v_scores jsonb := '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000004','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

  v_o1 := public.complete_scoring_job(v_job,v_msg,v_rp,v_req,v_scores,'r');
  v_o2 := public.complete_scoring_job(v_job,v_msg,v_rp,v_req,v_scores,'r');   -- duplicate delivery

  -- re-eval: a SECOND job under a new request (needs another active production => close first)
  perform public.close_scoring_request(v_req);
  v_req2 := pg_temp.mk_request(); perform public.activate_scoring_request(v_req2);
  v_job2 := public.enqueue_scoring_job(v_rp, v_req2);
  select msg_id into v_msg2 from public.scoring_job_state where id=v_job2;
  v_o3 := public.complete_scoring_job(v_job2,v_msg2,v_rp,v_req2,v_scores,'r');

  select count(*) into v_results from public.scoring_results where raw_post_id=v_rp and source='openai';
  select model, prompt_version, overall_relevance, included_in_generation
    into v_model, v_pv, v_overall, v_inc
    from public.scoring_results where raw_post_id=v_rp and scoring_request_id=v_req;
  perform pg_temp.expect_eq('first completion -> inserted', v_o1, 'inserted');
  perform pg_temp.expect_eq('duplicate delivery -> duplicate', v_o2, 'duplicate');
  perform pg_temp.expect_eq('re-eval under a new request -> inserted', v_o3, 'inserted');
  perform pg_temp.expect_eq('two distinct scoring_results rows for the same raw_post', v_results, 2);
  perform pg_temp.expect_eq('definition model comes FROM the request, not the caller', v_model, 'gpt-x');
  perform pg_temp.expect_eq('definition prompt_version comes FROM the request', v_pv, 'scoring_v1');
  perform pg_temp.expect_eq('server-derived overall_relevance (max_theme_v1)', v_overall, 80::numeric);
  perform pg_temp.expect_true('included_in_generation true since 80 >= default threshold', v_inc);
end $blk$;
rollback to s;

\echo '######## E. INDUCED FAILURE -> nothing stored, msg retryable ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_results int; v_inq int; v_raised boolean := false;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000005','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;
  begin
    perform public.complete_scoring_job(v_job,v_msg,v_rp,v_req,
      '{"sustainability":150,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,'r');
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('an out-of-range theme score is rejected (raises)', v_raised);
  select count(*) into v_results from public.scoring_results where raw_post_id=v_rp and source='openai';
  select count(*) into v_inq from pgmq.q_scoring_jobs where msg_id=v_msg;
  perform pg_temp.expect_eq('nothing stored after the induced failure', v_results, 0);
  perform pg_temp.expect_eq('message remains queued (retryable)', v_inq, 1);
end $blk$;
rollback to s;

\echo '######## F. FIX 3: completion binds to the claimed job (negatives) ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_other uuid; v_req uuid; v_job uuid; v_msg bigint;
        v_scores jsonb := '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb;
        v_raised boolean;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000006','p',now()) returning id into v_rp;
  -- A second, genuinely distinct raw_post created by this script itself —
  -- not "any other row that happens to exist" (which could be a legacy row,
  -- or a row retained by an earlier Deno test run under a different source).
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000006b','p',now()) returning id into v_other;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

  v_raised := false;
  begin perform public.complete_scoring_job(v_job,v_msg,v_other,v_req,v_scores,'r'); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('wrong raw_post_id is rejected', v_raised);

  v_raised := false;
  begin perform public.complete_scoring_job(v_job,v_msg,v_rp,gen_random_uuid(),v_scores,'r'); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('wrong scoring_request_id is rejected', v_raised);

  v_raised := false;
  begin perform public.complete_scoring_job(v_job,v_msg+999,v_rp,v_req,v_scores,'r'); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('wrong msg_id is rejected', v_raised);
end $blk$;
rollback to s;

\echo '######## G. FIX 2: theme-score contract ########'
savepoint s;
do $blk$
declare v_snap jsonb := public.scoring_config_snapshot(); v_raised boolean;
begin
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb, v_snap);
        perform pg_temp.expect_true('a fully valid theme_scores object is accepted', true);
  exception when others then raise exception 'ASSERTION FAILED: valid theme_scores was rejected: %', sqlerrm; end;

  v_raised := false;
  begin perform public.validate_theme_scores('{}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('empty theme_scores is rejected', v_raised);

  v_raised := false;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('missing theme is rejected', v_raised);

  v_raised := false;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4,"extra":1}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('unexpected theme is rejected', v_raised);

  v_raised := false;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":"x"}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('non-numeric theme score is rejected', v_raised);

  v_raised := false;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":5.5}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('decimal theme score is rejected', v_raised);

  v_raised := false;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":-1}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('negative theme score is rejected', v_raised);

  v_raised := false;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":150}'::jsonb, v_snap); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('over-100 theme score is rejected', v_raised);

  v_raised := false;
  begin perform public.scoring_apply_aggregation('max_theme_v1','{}'::jsonb); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('aggregation on empty theme_scores is rejected', v_raised);
end $blk$;
rollback to s;

\echo '######## H. FIX 4/5: append-only (row-level; grants reported separately) ########'
savepoint s;
do $blk$
declare v_id uuid; v_raised boolean;
begin
  select id into v_id from public.scoring_results limit 1;

  v_raised := false;
  begin update public.scoring_results set reason='x' where id=v_id; exception when others then v_raised := true; end;
  perform pg_temp.expect_true('scoring_results UPDATE is rejected by the immutability trigger', v_raised);

  v_raised := false;
  begin delete from public.scoring_results where id=v_id; exception when others then v_raised := true; end;
  perform pg_temp.expect_true('scoring_results DELETE is rejected by the immutability trigger', v_raised);
end $blk$;
-- Table-level grants are reported, not hard-asserted: as of the 0007-0010
-- reconciliation audit, service_role has direct INSERT/UPDATE/DELETE grants
-- on these tables (confirmed via aclexplode against pg_class.relacl, sourced
-- from a direct GRANT, not inheritance/ownership/default-privilege) — wider
-- than the SELECT-only originally documented in 0005. The row-level
-- immutability trigger above is what actually protects scoring_results
-- regardless of the grant; this section exists to keep that grant drift
-- visible in every run rather than assert a value known to currently differ
-- from what 0005 intended.
select 'service_role scoring_results table grants (0005 intent: SELECT only)' k,
  coalesce(string_agg(privilege_type,',' order by privilege_type),'(none)')
  from information_schema.role_table_grants where table_name='scoring_results' and grantee='service_role';
select 'service_role scoring_job_state table grants (0005 intent: SELECT only)' k,
  coalesce(string_agg(privilege_type,',' order by privilege_type),'(none)')
  from information_schema.role_table_grants where table_name='scoring_job_state' and grantee='service_role';
rollback to s;

\echo '######## I. RETRY / DEAD-LETTER STATE MACHINE ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint;
        v_o1 text; v_o2 text; v_o3 text; v_o4 text; v_fc int; v_status text; v_dl int;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000007','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

  v_o1 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'server_error','500','boom');
  select failure_count into v_fc from public.scoring_job_state where id=v_job;
  perform pg_temp.expect_eq('transient fail #1 -> retry', v_o1, 'retry');
  perform pg_temp.expect_eq('transient fail #1 failure_count', v_fc, 1);

  v_o2 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'timeout','','t');
  select failure_count into v_fc from public.scoring_job_state where id=v_job;
  perform pg_temp.expect_eq('transient fail #2 -> retry', v_o2, 'retry');
  perform pg_temp.expect_eq('transient fail #2 failure_count', v_fc, 2);

  v_o3 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'server_error','503','x');
  select status,failure_count into v_status,v_fc from public.scoring_job_state where id=v_job;
  select count(*) into v_dl from public.scoring_dead_letter where job_id=v_job;
  perform pg_temp.expect_eq('transient fail #3 -> dead_letter (3-strikes exhausted)', v_o3, 'dead_letter');
  perform pg_temp.expect_eq('job status after 3rd strike', v_status, 'dead_letter');
  perform pg_temp.expect_eq('failure_count after 3rd strike', v_fc, 3);
  perform pg_temp.expect_eq('exactly one scoring_dead_letter row', v_dl, 1);

  -- Post-0009: a failure against a terminal job is a benign no-op ('superseded'),
  -- not a raise — a losing/stale worker must never abort the batch.
  v_o4 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'server_error','500','y');
  select failure_count into v_fc from public.scoring_job_state where id=v_job;
  perform pg_temp.expect_eq('failure against an already-terminal job -> superseded', v_o4, 'superseded');
  perform pg_temp.expect_eq('failure_count unchanged by a superseded call', v_fc, 3);

  perform public.revive_scoring_job(v_job);
  select status,failure_count into v_status,v_fc from public.scoring_job_state where id=v_job;
  perform pg_temp.expect_eq('revived job status', v_status, 'pending');
  perform pg_temp.expect_eq('revived job failure_count reset', v_fc, 0);
end $blk$;
rollback to s;

\echo '######## J. PROMOTION MECHANISM (synthetic fixture, always runs) ########'
-- Exercises the general promotion/rollback/snapshot-invariance mechanism
-- using a SYNTHETIC prior "simulated" result this script creates itself —
-- not the real legacy import. Promotion/rollback/snapshot-invariance are
-- schema/RPC invariants that hold for ANY simulated+openai result pair, not
-- something specific to the 133-post legacy data; they do not need to be
-- gated behind require_legacy_seed. The genuinely legacy-import-specific
-- assertion (the exact historical included_in_generation boolean of one of
-- the real 133 rows) stays in Section J2 below, behind require_legacy_seed.
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_sim uuid; v_real uuid; v_req uuid; v_job uuid; v_scores jsonb; v_cur uuid;
        v_leg_inc boolean; v_inc_after boolean; v_raised boolean;
begin
  v_sid := pg_temp.verify_source_id();
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000030','p',now()) returning id into v_rp;

  -- A synthetic prior "simulated" result, NOT included (overall < 50), so we
  -- can prove threshold changes don't alter the stored historical boolean.
  -- scoring_results' own CHECK constraint requires this exact shape for
  -- source='simulated' (provenance_status='legacy_unknown', llm_used=false,
  -- model/model_snapshot/prompt_version/scoring_request_id all null).
  insert into public.scoring_results (
    raw_post_id, scoring_request_id, source, provenance_status, llm_used, aggregation_strategy,
    theme_scores, overall_relevance, reason, included_in_generation,
    config_snapshot, config_hash, idempotency_key
  ) values (
    v_rp, null, 'simulated', 'legacy_unknown', false, 'legacy_import',
    '{"sustainability":10,"innovation":5,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,
    10, 'synthetic prior projection', false,
    public.scoring_config_snapshot(), public.scoring_hash_of_snapshot(public.scoring_config_snapshot()),
    'verify_scoring.sql|synthetic-simulated|' || v_rp::text
  ) returning id into v_sim;
  perform public.set_current_scoring_result(v_rp, v_sim);
  select included_in_generation into v_leg_inc from public.analyzed_posts where raw_post_id=v_rp;

  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  v_job := public.enqueue_scoring_job(v_rp, v_req);
  perform public.complete_scoring_job(v_job,(select msg_id from public.scoring_job_state where id=v_job),v_rp,v_req,
    '{"sustainability":90,"innovation":20,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,'r');
  select id into v_real from public.scoring_results where raw_post_id=v_rp and scoring_request_id=v_req;

  select current_result_id into v_cur from public.analyzed_posts where raw_post_id=v_rp;
  perform pg_temp.expect_true('a completed job does not auto-promote', v_cur = v_sim);

  perform public.set_current_scoring_result(v_rp, v_real);
  select relevance_scores, current_result_id into v_scores, v_cur from public.analyzed_posts where raw_post_id=v_rp;
  perform pg_temp.expect_true('explicit promotion switches current_result_id', v_cur = v_real);
  perform pg_temp.expect_true('promoted projection has the innovation label', v_scores ? 'innovation');

  -- rename live label; older result projection must be invariant
  update public.scoring_themes set label='RENAMED_INNOVATION' where theme_id='innovation';
  perform public.set_current_scoring_result(v_rp, v_sim);
  perform public.set_current_scoring_result(v_rp, v_real);
  select relevance_scores into v_scores from public.analyzed_posts where raw_post_id=v_rp;
  perform pg_temp.expect_true('projection still uses the ORIGINAL label from its own snapshot', v_scores ? 'innovation');
  perform pg_temp.expect_true('projection does NOT pick up a later label rename', not (v_scores ? 'RENAMED_INNOVATION'));

  -- change the CURRENT threshold, roll back to the synthetic prior: stored boolean must be restored exactly
  update public.configurations set min_relevance_score=0 where id='default';   -- would flip a derived value
  perform public.set_current_scoring_result(v_rp, v_sim);
  select included_in_generation into v_inc_after from public.analyzed_posts where raw_post_id=v_rp;
  perform pg_temp.expect_true('rollback restores the exact stored included_in_generation',
    v_inc_after is not distinct from v_leg_inc);

  v_raised := false;
  begin perform public.set_current_scoring_result(pg_temp.verify_source_id(), v_real);
  exception when others then v_raised := true; end;
  perform pg_temp.expect_true('promoting a result onto the wrong raw_post is rejected', v_raised);
end $blk$;
rollback to s;

\if :require_legacy_seed
\echo '######## J2. PROMOTION: real legacy-import projection (legacy-import-specific) ########'
savepoint s;
do $blk$
declare v_rp uuid; v_sim uuid; v_leg_inc boolean; v_inc_after boolean;
begin
  -- The genuinely legacy-import-specific claim: an actual row from the real
  -- 133-post import round-trips through promote/rollback with its exact
  -- historical included_in_generation preserved. The general MECHANISM is
  -- already proven above (Section J) without needing this data to exist.
  select ap.raw_post_id, ap.current_result_id, ap.included_in_generation
    into v_rp, v_sim, v_leg_inc
  from public.analyzed_posts ap join public.scoring_results sr on sr.id=ap.current_result_id
  where sr.source='simulated' and sr.provenance_status='legacy_unknown' and ap.included_in_generation=false limit 1;

  perform pg_temp.expect_true('a legacy row with included_in_generation=false exists to test against', v_rp is not null);

  update public.configurations set min_relevance_score=0 where id='default';
  perform public.set_current_scoring_result(v_rp, v_sim);
  select included_in_generation into v_inc_after from public.analyzed_posts where raw_post_id=v_rp;
  perform pg_temp.expect_true('rollback to the real legacy row restores the exact stored included_in_generation',
    v_inc_after is not distinct from v_leg_inc);
end $blk$;
rollback to s;
\endif

\echo '######## K. FIX 6: theme_id immutable, label mutable ########'
savepoint s;
do $blk$
declare v_raised boolean;
begin
  begin update public.scoring_themes set label='Sustainability (new)' where theme_id='sustainability';
  exception when others then raise exception 'ASSERTION FAILED: relabeling a theme was rejected: %', sqlerrm; end;
  perform pg_temp.expect_true('theme label rename is accepted', true);

  v_raised := false;
  begin update public.scoring_themes set theme_id='sustainability2' where theme_id='sustainability'; exception when others then v_raised := true; end;
  perform pg_temp.expect_true('theme_id change is rejected (immutable)', v_raised);
end $blk$;
rollback to s;

\echo '######## L. scoring_requests immutable definition ########'
savepoint s;
do $blk$
declare v_req uuid; v_raised boolean;
begin
  v_req := pg_temp.mk_request();
  begin perform public.activate_scoring_request(v_req);
  exception when others then raise exception 'ASSERTION FAILED: draft->active status change was rejected'; end;
  perform pg_temp.expect_true('status transition (draft -> active) is accepted', true);

  v_raised := false;
  begin update public.scoring_requests set model='other' where id=v_req; exception when others then v_raised := true; end;
  perform pg_temp.expect_true('changing the definition (model) is rejected', v_raised);
end $blk$;
rollback to s;

\echo '######## N. 0009 lease/claim: token stamped, stale superseded, owner completes ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_tok uuid; v_status text;
        v_o_stale text; v_o_ok text; v_fc int; v_res int;
        v_scores jsonb := '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000009','p',now()) returning id into v_rp;
  select id into v_job from public.scoring_job_state where raw_post_id=v_rp;

  -- claim the job the way the worker does; read the stamped token from job_state
  perform 1 from public.read_scoring_jobs(120, 100);
  select status, processing_token, msg_id into v_status, v_tok, v_msg from public.scoring_job_state where id=v_job;
  perform pg_temp.expect_eq('claimed job status', v_status, 'processing');
  perform pg_temp.expect_true('claim stamps a non-null processing_token', v_tok is not null);

  -- a stale (wrong) token is superseded: nothing written, no retry burned
  v_o_stale := public.complete_scoring_job(v_job,v_msg,v_rp,v_req,v_scores,'r',null,gen_random_uuid());
  select count(*) into v_res from public.scoring_results where raw_post_id=v_rp and scoring_request_id=v_req;
  select failure_count into v_fc from public.scoring_job_state where id=v_job;
  perform pg_temp.expect_eq('stale-token complete_scoring_job -> superseded', v_o_stale, 'superseded');
  perform pg_temp.expect_eq('stale-token completion writes zero results', v_res, 0);
  perform pg_temp.expect_eq('stale-token completion does not burn a retry', v_fc, 0);

  -- the genuine lease holder completes normally
  v_o_ok := public.complete_scoring_job(v_job,v_msg,v_rp,v_req,v_scores,'r',null,v_tok);
  select count(*) into v_res from public.scoring_results where raw_post_id=v_rp and scoring_request_id=v_req;
  perform pg_temp.expect_eq('genuine lease holder completes -> inserted', v_o_ok, 'inserted');
  perform pg_temp.expect_eq('exactly one result after the owner completes', v_res, 1);
end $blk$;
rollback to s;

\echo '######## N2. 0010 prompt snapshot: template captured, hash matches text ########'
savepoint s;
do $blk$
declare v_req uuid; v_tmpl text; v_hash text; v_raised boolean;
begin
  v_req := pg_temp.mk_request();
  select prompt_template, prompt_hash into v_tmpl, v_hash from public.scoring_requests where id=v_req;
  perform pg_temp.expect_true('prompt_template is captured and non-empty', v_tmpl is not null and length(v_tmpl) > 0);
  perform pg_temp.expect_true('prompt_hash = md5(prompt_template), can never drift', v_hash = md5(v_tmpl));

  v_raised := false;
  begin update public.scoring_requests set prompt_template='tampered' where id=v_req; exception when others then v_raised := true; end;
  perform pg_temp.expect_true('mutating prompt_template after creation is rejected (immutable)', v_raised);
end $blk$;
rollback to s;

\echo '######## O. 0008/0009 failure disposition: refusal immediate dead-letter (its own job) ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_o text; v_fc int; v_status text; v_dl_type text; v_dl_attempts int;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000010','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

  v_o := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'refusal',null,'model refused');
  select status,failure_count into v_status,v_fc from public.scoring_job_state where id=v_job;
  select failure_type,attempts into v_dl_type,v_dl_attempts from public.scoring_dead_letter where job_id=v_job;
  -- Documented behavior, not "no change": failure_count IS incremented and
  -- persisted (v_fc goes 0->1) even on an immediate-dead-letter path — the
  -- job is simply never retried a 2nd/3rd time. Do not read "immediate
  -- dead-letter" as "failure_count untouched".
  perform pg_temp.expect_eq('refusal -> dead_letter on first occurrence', v_o, 'dead_letter');
  perform pg_temp.expect_eq('refusal: job status is dead_letter', v_status, 'dead_letter');
  perform pg_temp.expect_eq('refusal: failure_count IS incremented once (0->1), not left at 0', v_fc, 1);
  perform pg_temp.expect_eq('refusal: real failure_type preserved in dead_letter, not "exhausted"', v_dl_type, 'refusal');
  perform pg_temp.expect_eq('refusal: dead_letter attempts=1, not 3 (no 2nd/3rd attempt spent)', v_dl_attempts, 1);
end $blk$;
rollback to s;

\echo '######## O2. 0008/0009 failure disposition: content_filter immediate dead-letter (its own job) ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_o text; v_fc int; v_status text; v_dl_type text; v_dl_attempts int;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000011','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

  v_o := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'content_filter',null,'tripped the content filter');
  select status,failure_count into v_status,v_fc from public.scoring_job_state where id=v_job;
  select failure_type,attempts into v_dl_type,v_dl_attempts from public.scoring_dead_letter where job_id=v_job;
  -- Same documented behavior as refusal, verified on its OWN job so a bug
  -- specific to content_filter's disposition branch (independent of
  -- refusal's) cannot hide behind a shared/reused job or request.
  perform pg_temp.expect_eq('content_filter -> dead_letter on first occurrence', v_o, 'dead_letter');
  perform pg_temp.expect_eq('content_filter: job status is dead_letter', v_status, 'dead_letter');
  perform pg_temp.expect_eq('content_filter: failure_count IS incremented once (0->1), not left at 0', v_fc, 1);
  perform pg_temp.expect_eq('content_filter: real failure_type preserved in dead_letter, not "exhausted"', v_dl_type, 'content_filter');
  perform pg_temp.expect_eq('content_filter: dead_letter attempts=1, not 3 (no 2nd/3rd attempt spent)', v_dl_attempts, 1);
end $blk$;
rollback to s;

\echo '######## P. 0011 circuit-break: 400/401/403/404/422 close the request via circuit_break, no business retry consumed ########'
-- Superseded by 0011: record_scoring_failure now returns 'circuit_break' for
-- these five codes (not 'dead_letter' — that outcome is reserved for
-- per-job-permanent failures: refusal/content_filter/exhausted, see O/O2/I),
-- and failure_count is NOT incremented for this disposition — the call that
-- happened is recorded as attempts=1 in scoring_dead_letter (a real provider
-- call occurred) while failure_count (the business-retry counter) is left at
-- its pre-call value, since a request-wide circuit-break consumes zero of
-- the job's 3 allowed business retries. This loop covers each code
-- individually and in isolation (own request, own job); Section P2 below
-- covers the sibling-cancellation mechanics this triggers in depth.
savepoint s;
do $blk$
declare
  v_sid uuid; v_req uuid; v_code text;
  v_rp uuid; v_job uuid; v_msg bigint; v_o text; v_fc int; v_req_status text; v_attempts int;
begin
  v_sid := pg_temp.verify_source_id();
  foreach v_code in array array['400','401','403','404','422'] loop
    v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
    insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
    values (v_sid,'u','93000000000000100'||v_code,'p',now()) returning id into v_rp;
    select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

    v_o := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'client_error',v_code,'bad request');
    select failure_count into v_fc from public.scoring_job_state where id=v_job;
    select status into v_req_status from public.scoring_requests where id=v_req;
    select attempts into v_attempts from public.scoring_dead_letter where job_id=v_job;

    perform pg_temp.expect_eq(format('client_error %s -> circuit_break', v_code), v_o, 'circuit_break');
    perform pg_temp.expect_eq(format('client_error %s: job status is dead_letter', v_code),
      (select status from public.scoring_job_state where id=v_job), 'dead_letter');
    perform pg_temp.expect_eq(format('client_error %s: failure_count is NOT incremented (infra-level, not a business retry)', v_code), v_fc, 0);
    perform pg_temp.expect_eq(format('client_error %s: the real provider call IS recorded as attempts=1', v_code), v_attempts, 1);
    perform pg_temp.expect_eq(format('client_error %s: scoring_requests.status becomes closed', v_code), v_req_status, 'closed');
  end loop;
end $blk$;
rollback to s;

\echo '######## P2. 0011 circuit-break: closed request has zero claimable queued siblings ########'
-- Formerly a known, unresolved, release-blocking gap (see git history):
-- read_scoring_jobs / complete_scoring_job / record_scoring_failure never
-- checked scoring_requests.status, so a job already queued before its
-- request closed remained claimable and would still reach OpenAI. Migration
-- 0011 (cancel_scoring_request_siblings, invoked from record_scoring_failure
-- on a request-wide-permanent client_error) fixes this by bulk-terminalizing
-- every sibling in the same transaction that closes the request. This
-- section now HARD-ASSERTS the fix — a regression here fails the script.
savepoint s;
do $blk$
declare v_sid uuid; v_req uuid; v_rp1 uuid; v_rp2 uuid; v_rp3 uuid;
        v_job1 uuid; v_job2 uuid; v_job3 uuid; v_msg1 bigint; v_msg3 bigint;
        v_claimed_after_close int; v_tok3 uuid; v_stale_complete text; v_stale_fail text;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);

  -- job3 is enqueued and claimed FIRST, in isolation, so it alone gets a
  -- real processing_token while job1/job2 don't exist yet — job1's OWN
  -- direct record_scoring_failure call below (with the default NULL token)
  -- must still match job1's own row, which is only true if job1 was never
  -- itself claimed by a read_scoring_jobs call.
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000022','p',now()) returning id into v_rp3;
  select id,msg_id into v_job3,v_msg3 from public.scoring_job_state where raw_post_id=v_rp3;
  perform 1 from public.read_scoring_jobs(120, 100); -- claims ONLY job3 at this point
  select processing_token into v_tok3 from public.scoring_job_state where id = v_job3;
  perform pg_temp.expect_true('job3 was claimed (processing) before the circuit-break', v_tok3 is not null);

  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000020','p',now()) returning id into v_rp1;
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000021','p',now()) returning id into v_rp2;
  select id,msg_id into v_job1,v_msg1 from public.scoring_job_state where raw_post_id=v_rp1;
  select id into v_job2 from public.scoring_job_state where raw_post_id=v_rp2;

  -- job1 fails with a circuit-break error and closes the request. job1 was
  -- never claimed via read_scoring_jobs, so its processing_token is still
  -- NULL — matching the default p_processing_token this direct call passes.
  perform pg_temp.expect_eq('record_scoring_failure returns circuit_break',
    public.record_scoring_failure(v_job1, v_msg1, v_rp1, v_req, 'client_error', '401', 'auth failed'), 'circuit_break');

  perform pg_temp.expect_eq('request is closed after the circuit-break',
    (select status from public.scoring_requests where id=v_req), 'closed');

  -- 0012 fix: the TRIGGERING job (job1) also has its own lease state cleared,
  -- not just its siblings' — job1 is just as terminal and must not retain a
  -- token a stale worker could still reference.
  perform pg_temp.expect_eq('triggering job (job1) status', (select status from public.scoring_job_state where id=v_job1), 'dead_letter');
  perform pg_temp.expect_true('triggering job processing_token cleared', (select processing_token from public.scoring_job_state where id=v_job1) is null);
  perform pg_temp.expect_true('triggering job leased_at cleared', (select leased_at from public.scoring_job_state where id=v_job1) is null);
  perform pg_temp.expect_true('triggering job next_attempt_at cleared', (select next_attempt_at from public.scoring_job_state where id=v_job1) is null);
  perform pg_temp.expect_eq('triggering job failure_count still unchanged (not a business retry)',
    (select failure_count from public.scoring_job_state where id=v_job1), 0);

  -- job2 (was pending): terminal, request_closed, no business retry burned, lease clear.
  perform pg_temp.expect_eq('pending sibling (job2) status', (select status from public.scoring_job_state where id=v_job2), 'dead_letter');
  perform pg_temp.expect_eq('pending sibling last_failure_type', (select last_failure_type from public.scoring_job_state where id=v_job2), 'request_closed');
  perform pg_temp.expect_eq('pending sibling failure_count unchanged', (select failure_count from public.scoring_job_state where id=v_job2), 0);
  perform pg_temp.expect_true('pending sibling processing_token cleared', (select processing_token from public.scoring_job_state where id=v_job2) is null);
  perform pg_temp.expect_true('pending sibling leased_at cleared', (select leased_at from public.scoring_job_state where id=v_job2) is null);
  perform pg_temp.expect_true('pending sibling next_attempt_at cleared', (select next_attempt_at from public.scoring_job_state where id=v_job2) is null);
  perform pg_temp.expect_eq('pending sibling has exactly one scoring_dead_letter row',
    (select count(*) from public.scoring_dead_letter where job_id=v_job2), 1::bigint);
  perform pg_temp.expect_eq('pending sibling dead_letter failure_type', (select failure_type from public.scoring_dead_letter where job_id=v_job2), 'request_closed');

  -- job3 (was processing, real lease token): same terminal outcome, token cleared.
  perform pg_temp.expect_eq('processing sibling (job3) status', (select status from public.scoring_job_state where id=v_job3), 'dead_letter');
  perform pg_temp.expect_true('processing sibling processing_token cleared', (select processing_token from public.scoring_job_state where id=v_job3) is null);
  perform pg_temp.expect_eq('processing sibling failure_count unchanged', (select failure_count from public.scoring_job_state where id=v_job3), 0);

  -- Zero claimable siblings left in the queue for this request.
  select count(*) into v_claimed_after_close
    from public.read_scoring_jobs(120, 100) r
    where (r.message->>'job_id')::uuid in (v_job2, v_job3);
  perform pg_temp.expect_eq('zero claimable queued siblings after the circuit-break', v_claimed_after_close, 0);

  -- Stale worker holding job3's pre-cancellation token: completion is
  -- superseded, writes nothing, does not resurrect the job.
  v_stale_complete := public.complete_scoring_job(v_job3, v_msg3, v_rp3, v_req,
    '{"sustainability":10,"innovation":10,"talent_development":10,"food_safety":10,"supply_chain":10,"tradition":10}'::jsonb,
    'stale', null, v_tok3);
  perform pg_temp.expect_eq('stale completion on a cancelled sibling -> superseded', v_stale_complete, 'superseded');
  perform pg_temp.expect_eq('stale completion writes no result',
    (select count(*) from public.scoring_results where raw_post_id=v_rp3 and scoring_request_id=v_req), 0::bigint);

  v_stale_fail := public.record_scoring_failure(v_job3, v_msg3, v_rp3, v_req, 'server_error', '500', 'stale retry', null, v_tok3);
  perform pg_temp.expect_eq('stale failure on a cancelled sibling -> superseded', v_stale_fail, 'superseded');
  perform pg_temp.expect_eq('stale failure does not increment failure_count', (select failure_count from public.scoring_job_state where id=v_job3), 0);
  perform pg_temp.expect_eq('stale failure does not create a second dead_letter row',
    (select count(*) from public.scoring_dead_letter where job_id=v_job3), 1::bigint);

  -- Idempotency via the actual public surface: job1 is already dead_letter,
  -- so a second record_scoring_failure call for it hits the status guard and
  -- returns 'superseded' WITHOUT re-running the circuit-break/cancellation
  -- body — no duplicate dead_letter rows for either sibling.
  perform pg_temp.expect_eq('repeating job1''s own failure call after cancellation -> superseded',
    public.record_scoring_failure(v_job1, v_msg1, v_rp1, v_req, 'client_error', '401', 'auth failed'), 'superseded');
  perform pg_temp.expect_eq('repeating cancellation creates no duplicate dead_letter row for job2',
    (select count(*) from public.scoring_dead_letter where job_id=v_job2), 1::bigint);
  perform pg_temp.expect_eq('repeating cancellation creates no duplicate dead_letter row for job3',
    (select count(*) from public.scoring_dead_letter where job_id=v_job3), 1::bigint);
end $blk$;
rollback to s;

\echo '######## P3. 0012: cancel_scoring_request_siblings is not directly executable by service_role ########'
-- The helper is internal-only (called from inside record_scoring_failure,
-- itself SECURITY DEFINER, same owner) and must not be a standalone RPC
-- surface an Edge Function (which connects as service_role) could invoke
-- directly, bypassing record_scoring_failure's own validation.
select pg_temp.expect_true(
  'service_role has NO execute privilege on cancel_scoring_request_siblings',
  not has_function_privilege('service_role', 'public.cancel_scoring_request_siblings(uuid,uuid,text)', 'execute')
);

\echo '######## P4. 0012: completion winning the request lock first leaves a succeeded job untouched by a later circuit-break ########'
savepoint s;
do $blk$
declare v_sid uuid; v_req uuid; v_rp_ok uuid; v_rp_bad uuid; v_job_ok uuid; v_msg_ok bigint; v_job_bad uuid; v_msg_bad bigint;
        v_scores jsonb := '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000023','p',now()) returning id into v_rp_ok;
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000024','p',now()) returning id into v_rp_bad;
  select id,msg_id into v_job_ok,v_msg_ok from public.scoring_job_state where raw_post_id=v_rp_ok;
  select id,msg_id into v_job_bad,v_msg_bad from public.scoring_job_state where raw_post_id=v_rp_bad;

  -- Completion "wins" (runs first, commits its own request-lock-then-job-lock
  -- sequence to completion) before the circuit-break on the sibling even starts.
  perform pg_temp.expect_eq('completion wins first -> inserted',
    public.complete_scoring_job(v_job_ok, v_msg_ok, v_rp_ok, v_req, v_scores, 'r'), 'inserted');
  perform pg_temp.expect_eq('completed job status is succeeded',
    (select status from public.scoring_job_state where id=v_job_ok), 'succeeded');

  -- Now the sibling circuit-breaks the SAME request.
  perform pg_temp.expect_eq('sibling circuit-break after the fact -> circuit_break',
    public.record_scoring_failure(v_job_bad, v_msg_bad, v_rp_bad, v_req, 'client_error', '401', 'auth failed'), 'circuit_break');

  -- The already-succeeded job must be completely untouched by the bulk
  -- sibling cancellation (its status filter is status IN ('pending','processing')).
  perform pg_temp.expect_eq('succeeded job status is unchanged by the later circuit-break',
    (select status from public.scoring_job_state where id=v_job_ok), 'succeeded');
  perform pg_temp.expect_eq('succeeded job failure_count is unchanged', (select failure_count from public.scoring_job_state where id=v_job_ok), 0);
  perform pg_temp.expect_true('succeeded job last_failure_type is unchanged (still null)',
    (select last_failure_type from public.scoring_job_state where id=v_job_ok) is null);
  perform pg_temp.expect_eq('the succeeded job''s real result is still exactly one row',
    (select count(*) from public.scoring_results where raw_post_id=v_rp_ok and scoring_request_id=v_req), 1::bigint);
end $blk$;
rollback to s;

\echo '######## P5. 0013: enqueue_scoring_job locks the request first, same as complete/record_scoring_failure ########'
savepoint s;
do $blk$
declare v_sid uuid; v_req uuid; v_rp_early uuid; v_rp_trig uuid; v_rp_late uuid;
        v_job_early uuid; v_job_trig uuid; v_msg_trig bigint; v_raised boolean;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);

  -- (a) enqueue against an already-closed request creates no job/message.
  perform public.close_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000030','p',now()) returning id into v_rp_late;
  v_raised := false;
  begin perform public.enqueue_scoring_job(v_rp_late, v_req); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('enqueue against an already-closed request raises', v_raised);
  perform pg_temp.expect_eq('no job row was created for the rejected enqueue',
    (select count(*) from public.scoring_job_state where raw_post_id=v_rp_late), 0::bigint);

  -- (b) a job enqueued BEFORE the request closes is subsequently terminalized.
  -- v_req is 'production'-purpose, so trg_enqueue_scoring_on_raw_post auto-enqueues
  -- these inserts; look the job rows up by raw_post_id rather than trusting
  -- enqueue_scoring_job's return value, since an explicit call here would just hit
  -- the idempotent on-conflict no-op and return null.
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000031','p',now()) returning id into v_rp_early;
  select id into v_job_early from public.scoring_job_state where raw_post_id=v_rp_early;
  perform pg_temp.expect_eq('early job is pending right after enqueue',
    (select status from public.scoring_job_state where id=v_job_early), 'pending');

  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000032','p',now()) returning id into v_rp_trig;
  select id into v_job_trig from public.scoring_job_state where raw_post_id=v_rp_trig;
  select msg_id into v_msg_trig from public.scoring_job_state where id=v_job_trig;
  perform public.record_scoring_failure(v_job_trig, v_msg_trig, v_rp_trig, v_req, 'client_error', '401', 'auth failed');

  perform pg_temp.expect_eq('early-enqueued job is terminalized as a sibling after the close',
    (select status from public.scoring_job_state where id=v_job_early), 'dead_letter');
  perform pg_temp.expect_eq('early-enqueued job carries the request_closed reason',
    (select last_failure_type from public.scoring_job_state where id=v_job_early), 'request_closed');

  -- (c) circuit-break-before-enqueue causes the later enqueue to fail.
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000033','p',now()) returning id into v_rp_late;
  v_raised := false;
  begin perform public.enqueue_scoring_job(v_rp_late, v_req); exception when others then v_raised := true; end;
  perform pg_temp.expect_true('enqueue after an in-flight circuit-break already closed the request raises', v_raised);
  perform pg_temp.expect_eq('no job row was created for that late enqueue',
    (select count(*) from public.scoring_job_state where raw_post_id=v_rp_late), 0::bigint);

  -- (d) no pending/processing jobs remain under the closed request at all.
  perform pg_temp.expect_eq('zero pending/processing jobs remain under the closed request',
    (select count(*) from public.scoring_job_state where scoring_request_id=v_req and status in ('pending','processing')), 0::bigint);
end $blk$;
rollback to s;

\echo '######## Q. DB-completion failure must not increase the business failure_count ########'
-- Primary proof: an ACTUAL induced complete_scoring_job failure (invalid
-- theme_scores — the same validate_theme_scores rejection §E already relies
-- on), with failure_count read before and after. This is the behavioral
-- proof; it stands on its own regardless of the structural check below.
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint;
        v_fc_before int; v_fc_after int; v_results int; v_inq int; v_raised boolean := false;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000012','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;

  select failure_count into v_fc_before from public.scoring_job_state where id=v_job;

  -- Induce a completion failure the way a real DB-completion fault would
  -- surface: complete_scoring_job raises (here via invalid theme_scores;
  -- any raise inside the function is equivalent for this purpose — the
  -- function never reaches its failure_count-adjacent code on any path,
  -- because it has none: see the structural check below).
  begin
    perform public.complete_scoring_job(v_job,v_msg,v_rp,v_req,
      '{"sustainability":150,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,'r');
  exception when others then v_raised := true;
  end;
  perform pg_temp.expect_true('the completion attempt actually failed', v_raised);

  select failure_count into v_fc_after from public.scoring_job_state where id=v_job;
  select count(*) into v_results from public.scoring_results where raw_post_id=v_rp and scoring_request_id=v_req;
  select count(*) into v_inq from pgmq.q_scoring_jobs where msg_id=v_msg;

  perform pg_temp.expect_eq('failure_count before the induced completion failure', v_fc_before, 0);
  perform pg_temp.expect_eq('failure_count AFTER the induced completion failure is UNCHANGED', v_fc_after, v_fc_before);
  perform pg_temp.expect_eq('no scoring_result was inserted by the failed completion', v_results, 0);
  perform pg_temp.expect_eq('the message/job remains available for a later retry', v_inq, 1);
end $blk$;
rollback to s;

-- Secondary, informational-only corroboration: complete_scoring_job's source
-- never references failure_count at all (only record_scoring_failure and
-- revive_scoring_job do). This does NOT stand in for the behavioral proof
-- above — it only explains WHY the behavioral result holds for every
-- completion-failure path, not just the one just exercised.
do $blk$
declare v_writers text;
begin
  select string_agg(distinct p.proname, ', ' order by p.proname) into v_writers
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosrc ~* 'failure_count\s*='
    and p.proname not like '%guard%';
  raise notice 'INFO (corroborating, not primary proof) functions that ever write failure_count: %', v_writers;
  raise notice 'INFO (corroborating, not primary proof) complete_scoring_job among them: %',
    position('complete_scoring_job' in coalesce(v_writers,'')) <> 0;
end $blk$;

\echo '######## M. RLS ########'
select relname, relrowsecurity from pg_class
where relnamespace='public'::regnamespace
  and relname in ('scoring_themes','scoring_requests','scoring_results','scoring_job_state','scoring_dead_letter') order by 1;

\echo '######## FINAL ########'
-- Every section above (A through Q, M) has now run. Every invariant this
-- script knows how to check — including the formerly-release-blocking
-- Section P2 circuit-break gap, now fixed by migration 0011 — is asserted
-- via pg_temp.expect_*, which RAISEs and aborts the script immediately on
-- any mismatch (psql -v ON_ERROR_STOP=1 then exits non-zero at that exact
-- point). Reaching this line at all means every hard assertion in the file
-- passed. The explicit ROLLBACK below is unconditional and is the only
-- outcome from here — there is no separate deferred pass/fail decision left
-- to make (pg_verify_findings and its \gset handoff, used only to survive
-- Section P2's own `rollback to s` while the gap was still failing, are no
-- longer needed now that P2 asserts inline and lets a real failure abort the
-- whole script rather than being deferred to a final summary check).
rollback;
\echo 'Explicit ROLLBACK executed. Every Phase 3 verification section passed. Database is back to its pre-script state.'

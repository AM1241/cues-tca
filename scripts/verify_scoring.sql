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

-- Verification state that must survive a `rollback to s` inside a later
-- section (a savepoint rollback undoes regular table writes made after the
-- savepoint, but NOT the temp table's row once created here, before any
-- savepoint exists). Read once, right before the final `rollback;`, so every
-- later section still gets to run regardless of what this one finds.
create temp table pg_verify_findings (
  finding      text primary key,
  gap_present  boolean not null,
  detail       text
);

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

\echo '######## P. 0008/0009 circuit-break: 400/401/403/404/422 close the request, failure_count still increments ########'
savepoint s;
do $blk$
declare
  v_sid uuid; v_req uuid; v_code text;
  v_rp uuid; v_job uuid; v_msg bigint; v_o text; v_fc int; v_req_status text;
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

    perform pg_temp.expect_eq(format('client_error %s -> dead_letter (circuit-break)', v_code), v_o, 'dead_letter');
    -- Documented, exact behavior for this code: failure_count IS incremented
    -- and persisted (0->1) before the circuit-break logic runs; it is NOT
    -- left unchanged. What IS true: no 2nd or 3rd attempt is ever spent —
    -- the job is dead-lettered on the very first call for this failure type.
    perform pg_temp.expect_eq(format('client_error %s: failure_count IS incremented once (0->1)', v_code), v_fc, 1);
    perform pg_temp.expect_eq(format('client_error %s: scoring_requests.status becomes closed', v_code), v_req_status, 'closed');
  end loop;
end $blk$;
rollback to s;

\echo '######## P2. KNOWN RELEASE-BLOCKING GAP: closing a request does not stop an already-queued sibling job ########'
-- This section reports a real, unresolved gap found during the 0007-0010
-- reconciliation audit — it does NOT assert the gap as a passing invariant.
-- read_scoring_jobs / complete_scoring_job / record_scoring_failure never
-- check scoring_requests.status. A job that was pending BEFORE its request
-- closed remains claimable, will be sent to OpenAI, and will individually
-- retry/dead-letter through the normal path — the circuit-break only stops
-- NEW enqueues (enqueue_scoring_job DOES check status='active' and raises
-- otherwise), not jobs already in the queue.
--
-- verify_scoring.sql CANNOT be described as fully green while this gap
-- exists: this DO block deliberately does not use pg_temp.expect_* (which
-- would make "the bug is present" the passing condition). It prints the
-- measured outcome as a NOTICE and, at the end of the script, this section's
-- result is surfaced again in the final summary as an explicit, unresolved
-- finding — not folded into the pass count.
-- IMPORTANT: `ROLLBACK TO SAVEPOINT` undoes every DML statement issued since
-- that savepoint — including an INSERT into pg_verify_findings, even though
-- pg_verify_findings itself was CREATEd before any savepoint existed. Only
-- the temp table's existence survives; rows written after the savepoint do
-- not. So the finding is written to a psql CLIENT variable (via \gset, which
-- runs client-side and is unaffected by what the server later rolls back)
-- BEFORE `rollback to s`, then re-inserted into pg_verify_findings from that
-- client variable AFTER the rollback, once the savepoint's rollback can no
-- longer touch it.
savepoint s;
do $blk$
declare v_sid uuid; v_req uuid; v_rp1 uuid; v_rp2 uuid; v_job1 uuid; v_job2 uuid; v_msg1 bigint;
        v_claimed_after_close int;
begin
  v_sid := pg_temp.verify_source_id();
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000020','p',now()) returning id into v_rp1;
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000021','p',now()) returning id into v_rp2;
  select id,msg_id into v_job1,v_msg1 from public.scoring_job_state where raw_post_id=v_rp1;
  select id into v_job2 from public.scoring_job_state where raw_post_id=v_rp2;

  -- job1 fails with a circuit-break error and closes the request. This part
  -- of the circuit-break IS a working invariant, so it IS hard-asserted.
  perform public.record_scoring_failure(v_job1,v_msg1,v_rp1,v_req,'client_error','401','auth failed');
  perform pg_temp.expect_eq('request is closed after the circuit-break',
    (select status from public.scoring_requests where id=v_req), 'closed');
  perform pg_temp.expect_eq('sibling job2 is still pending, untouched by the close',
    (select status from public.scoring_job_state where id=v_job2), 'pending');

  -- Measure whether job2's message is STILL claimable despite its request
  -- being closed. This is reported, not asserted either way, because a
  -- future fix changing this count to 0 must not fail this script, and the
  -- current gap-present count of 1 must not be celebrated as "green".
  select count(*) into v_claimed_after_close
    from public.read_scoring_jobs(120, 100) r where (r.message->>'job_id')::uuid = v_job2;
  if v_claimed_after_close not in (0, 1) then
    raise exception 'ASSERTION FAILED: unexpected claim count % for job % (expected 0 or 1)', v_claimed_after_close, v_job2;
  end if;

  -- Result is left in a temp row that the client reads via \gset immediately
  -- below (before `rollback to s` — see the note above this block).
  create temp table p2_result as
  select (v_claimed_after_close = 1) as gap_present, v_job2::text as job2, v_req::text as req;
end $blk$;

select gap_present as p2_gap_present, job2 as p2_job2, req as p2_req from p2_result \gset
drop table p2_result;

\if :p2_gap_present
\echo 'GAP CONFIRMED (release-blocking, unresolved): read_scoring_jobs claimed a job whose request was already closed. A worker invocation reading this batch would call OpenAI for it despite the circuit-break.'
\else
\echo 'GAP APPEARS RESOLVED: read_scoring_jobs did NOT claim the job under the closed request — if intentional, promote this check to a hard pg_temp.expect_eq(..., 0) assertion.'
\endif

rollback to s;

insert into pg_verify_findings (finding, gap_present, detail) values
  ('closed_request_queued_job_claimable', :'p2_gap_present',
   format('job %s under closed request %s: claimable-after-close=%s', :'p2_job2', :'p2_req', :'p2_gap_present'))
  on conflict (finding) do update set gap_present = excluded.gap_present, detail = excluded.detail;

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

\echo '######## FINAL: release-blocking findings ########'
-- Every other section above has already run by this point, regardless of
-- what this check finds. This is the ONE place in the file where a known,
-- reported gap is turned into a hard failure — deliberately last, so it
-- cannot mask or shortcut any other section's assertions.
--
-- Explicit ROLLBACK happens BEFORE the pass/fail decision below, not after
-- (and not merely implied by session/script termination): the gap state is
-- pulled out of the (about-to-be-destroyed) temp table into psql CLIENT
-- variables via \gset first, then ROLLBACK runs unconditionally, and only
-- after that does the script decide whether to exit non-zero. This
-- guarantees the transaction is always cleanly rolled back even in the
-- gap-present case — the non-zero exit is a client-side psql decision made
-- after the database is already back to its pre-script state, not something
-- that depends on the transaction being aborted to roll back.
do $blk$
declare v_gap_present boolean; v_detail text;
begin
  select gap_present, detail into v_gap_present, v_detail
    from pg_verify_findings where finding = 'closed_request_queued_job_claimable';
  if v_gap_present is null then
    raise exception 'ASSERTION FAILED: expected finding closed_request_queued_job_claimable was never recorded — Section P2 did not run';
  end if;
end $blk$;

select
  gap_present as final_gap_present,
  coalesce(detail, '(no detail)') as final_gap_detail
from pg_verify_findings where finding = 'closed_request_queued_job_claimable' \gset

rollback;

\echo 'Explicit ROLLBACK executed. Transaction ended; database is back to its pre-script state.'

\if :final_gap_present
\echo 'closed request still has claimable queued jobs'
\echo 'Detail:' :'final_gap_detail'
\echo 'This is the sole expected release-blocking failure. Every other Phase 3 verification section above passed.'
\warn 'verify_scoring.sql: FAIL — closed request still has claimable queued jobs'
select 1/0;
\else
\echo 'OK: closed-request circuit-break gap is resolved.' :'final_gap_detail'
\endif

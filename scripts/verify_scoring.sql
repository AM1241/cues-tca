-- Phase 3B verification (scoring_requests structure). One transaction, rolled back.
--   psql "$DB_URL" -f scripts/verify_scoring.sql
\pset pager off
\set ON_ERROR_STOP off
begin;

-- Helper: open an active production request for the current live config.
create or replace function pg_temp.mk_request() returns uuid
language sql as $$
  select public.create_scoring_request('production','scoring_v1','ph1',
    public.scoring_config_snapshot(),'gpt-x','gpt-x-2026-01','max_theme_v1')
$$;

\echo '######## A. MIGRATIONS + LEGACY IMPORT ########'
select 'migrations' k, string_agg(version, ',' order by version) from supabase_migrations.schema_migrations;
do $blk$
declare v_res int; v_prov int; v_reqnull int; v_analyzed int; v_cur int; v_jobs int; v_themes int; v_reqs int;
begin
  select count(*) into v_res from public.scoring_results;
  select count(*) into v_prov from public.scoring_results where source='simulated' and provenance_status='legacy_unknown'
     and llm_used=false and model is null and prompt_version is null;
  select count(*) into v_reqnull from public.scoring_results where source='simulated' and scoring_request_id is null;
  select count(*) into v_analyzed from public.analyzed_posts;
  select count(*) into v_cur from public.analyzed_posts ap join public.scoring_results sr on sr.id=ap.current_result_id where sr.source='simulated';
  select count(*) into v_jobs from public.scoring_job_state;
  select count(*) into v_reqs from public.scoring_requests;
  select count(*) into v_themes from public.scoring_themes;
  raise notice 'RESULT results=% legacy_unknown=% request_id_null=% (expect 133,133,133)', v_res, v_prov, v_reqnull;
  raise notice 'RESULT analyzed=% pointing-at-simulated=% jobs=% requests=% themes=% (expect 133,133,0,0,6)', v_analyzed, v_cur, v_jobs, v_reqs, v_themes;
end $blk$;

\echo '######## B. NO request => trigger does not enqueue; with active request it does ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_j0 int; v_j1 int;
begin
  select id into v_sid from public.sources limit 1;
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000001','p',now()) returning id into v_rp;
  select count(*) into v_j0 from public.scoring_job_state where raw_post_id=v_rp;   -- no active request yet
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000002','p',now()) returning id into v_rp;
  select count(*) into v_j1 from public.scoring_job_state where raw_post_id=v_rp;   -- now enqueued
  raise notice 'RESULT pipeline post: no-request jobs=% active-request jobs=% (expect 0,1)', v_j0, v_j1;
end $blk$;
rollback to s;

\echo '######## C. FIX 1: no duplicate logical job after success ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_j1 int; v_j2 int; v_m2 int; v_new uuid;
begin
  select id into v_sid from public.sources limit 1;
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
  raise notice 'RESULT succeeded+2x backfill: jobs %->% queued=% (expect 1->1,0)', v_j1, v_j2, v_m2;
end $blk$;
rollback to s;

\echo '######## D. COMPLETION: worker cannot override definition; duplicate; re-eval ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_req2 uuid; v_job uuid; v_msg bigint; v_job2 uuid; v_msg2 bigint;
        v_o1 text; v_o2 text; v_o3 text; v_results int; v_model text; v_pv text; v_overall numeric; v_inc boolean;
        v_scores jsonb := '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb;
begin
  select id into v_sid from public.sources limit 1;
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
  raise notice 'RESULT out1=% out2=% out3=% results=% (expect inserted,duplicate,inserted,2)', v_o1, v_o2, v_o3, v_results;
  raise notice 'RESULT definition FROM request: model=% prompt=% (expect gpt-x, scoring_v1)', v_model, v_pv;
  raise notice 'RESULT server-derived overall=% included=% (expect 80, t since 80>=50)', v_overall, v_inc;
end $blk$;
rollback to s;

\echo '######## E. INDUCED FAILURE -> nothing stored, msg retryable ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint; v_results int; v_inq int;
begin
  select id into v_sid from public.sources limit 1;
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000005','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;
  begin
    perform public.complete_scoring_job(v_job,v_msg,v_rp,v_req,
      '{"sustainability":150,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,'r');
    raise notice 'RESULT induced failure: NO ERROR (BAD)';
  exception when others then raise notice 'RESULT induced failure rejected (expect this)';
  end;
  select count(*) into v_results from public.scoring_results where raw_post_id=v_rp and source='openai';
  select count(*) into v_inq from pgmq.q_scoring_jobs where msg_id=v_msg;
  raise notice 'RESULT after induced failure: results=% msg_in_queue=% (expect 0,1)', v_results, v_inq;
end $blk$;
rollback to s;

\echo '######## F. FIX 3: completion binds to the claimed job (negatives) ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_other uuid; v_req uuid; v_job uuid; v_msg bigint;
        v_scores jsonb := '{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb;
begin
  select id into v_sid from public.sources limit 1;
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000006','p',now()) returning id into v_rp;
  select id into v_other from public.raw_posts where id<>v_rp limit 1;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;
  begin perform public.complete_scoring_job(v_job,v_msg,v_other,v_req,v_scores,'r'); raise notice 'RESULT wrong raw_post NO ERROR (BAD)'; exception when others then raise notice 'RESULT wrong raw_post rejected'; end;
  begin perform public.complete_scoring_job(v_job,v_msg,v_rp,gen_random_uuid(),v_scores,'r'); raise notice 'RESULT wrong request NO ERROR (BAD)'; exception when others then raise notice 'RESULT wrong request rejected'; end;
  begin perform public.complete_scoring_job(v_job,v_msg+999,v_rp,v_req,v_scores,'r'); raise notice 'RESULT wrong msg_id NO ERROR (BAD)'; exception when others then raise notice 'RESULT wrong msg_id rejected'; end;
end $blk$;
rollback to s;

\echo '######## G. FIX 2: theme-score contract ########'
savepoint s;
do $blk$
declare v_snap jsonb := public.scoring_config_snapshot();
begin
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb, v_snap); raise notice 'RESULT valid accepted (expect this)'; exception when others then raise notice 'RESULT valid REJECTED (BAD): %', sqlerrm; end;
  begin perform public.validate_theme_scores('{}'::jsonb, v_snap); raise notice 'RESULT empty ACCEPTED (BAD)'; exception when others then raise notice 'RESULT empty rejected'; end;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7}'::jsonb, v_snap); raise notice 'RESULT missing ACCEPTED (BAD)'; exception when others then raise notice 'RESULT missing-theme rejected'; end;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4,"extra":1}'::jsonb, v_snap); raise notice 'RESULT unexpected ACCEPTED (BAD)'; exception when others then raise notice 'RESULT unexpected-theme rejected'; end;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":"x"}'::jsonb, v_snap); raise notice 'RESULT non-numeric ACCEPTED (BAD)'; exception when others then raise notice 'RESULT non-numeric rejected'; end;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":5.5}'::jsonb, v_snap); raise notice 'RESULT decimal ACCEPTED (BAD)'; exception when others then raise notice 'RESULT decimal rejected'; end;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":-1}'::jsonb, v_snap); raise notice 'RESULT negative ACCEPTED (BAD)'; exception when others then raise notice 'RESULT negative rejected'; end;
  begin perform public.validate_theme_scores('{"sustainability":10,"innovation":80,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":150}'::jsonb, v_snap); raise notice 'RESULT over-100 ACCEPTED (BAD)'; exception when others then raise notice 'RESULT over-100 rejected'; end;
  begin perform public.scoring_apply_aggregation('max_theme_v1','{}'::jsonb); raise notice 'RESULT empty-agg ACCEPTED (BAD)'; exception when others then raise notice 'RESULT empty aggregation rejected'; end;
end $blk$;
rollback to s;

\echo '######## H. FIX 4/5: append-only + trusted grants ########'
savepoint s;
do $blk$
declare v_id uuid;
begin
  select id into v_id from public.scoring_results limit 1;
  begin update public.scoring_results set reason='x' where id=v_id; raise notice 'RESULT UPDATE ACCEPTED (BAD)'; exception when others then raise notice 'RESULT UPDATE rejected'; end;
  begin delete from public.scoring_results where id=v_id; raise notice 'RESULT DELETE ACCEPTED (BAD)'; exception when others then raise notice 'RESULT DELETE rejected'; end;
end $blk$;
select 'service_role scoring_results priv (expect SELECT)' k, coalesce(string_agg(privilege_type,',' order by privilege_type),'(none)')
  from information_schema.role_table_grants where table_name='scoring_results' and grantee='service_role';
select 'service_role scoring_job_state priv (expect SELECT)' k, coalesce(string_agg(privilege_type,',' order by privilege_type),'(none)')
  from information_schema.role_table_grants where table_name='scoring_job_state' and grantee='service_role';
rollback to s;

\echo '######## I. RETRY / DEAD-LETTER STATE MACHINE ########'
savepoint s;
do $blk$
declare v_sid uuid; v_rp uuid; v_req uuid; v_job uuid; v_msg bigint;
        v_o1 text; v_o2 text; v_o3 text; v_fc int; v_status text; v_dl int;
begin
  select id into v_sid from public.sources limit 1;
  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  insert into public.raw_posts (source_id,source_url,external_post_id,post_text,published_at)
  values (v_sid,'u','9300000000000000007','p',now()) returning id into v_rp;
  select id,msg_id into v_job,v_msg from public.scoring_job_state where raw_post_id=v_rp;
  v_o1 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'server_error','500','boom');
  select failure_count into v_fc from public.scoring_job_state where id=v_job;
  raise notice 'RESULT fail#1 -> % fc=% (expect retry,1)', v_o1, v_fc;
  v_o2 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'timeout','','t');
  select failure_count into v_fc from public.scoring_job_state where id=v_job;
  raise notice 'RESULT fail#2 -> % fc=% (expect retry,2)', v_o2, v_fc;
  v_o3 := public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'server_error','503','x');
  select status,failure_count into v_status,v_fc from public.scoring_job_state where id=v_job;
  select count(*) into v_dl from public.scoring_dead_letter where job_id=v_job;
  raise notice 'RESULT fail#3 -> % status=% fc=% dl_rows=% (expect dead_letter,dead_letter,3,1)', v_o3, v_status, v_fc, v_dl;
  begin perform public.record_scoring_failure(v_job,v_msg,v_rp,v_req,'server_error','500','y'); raise notice 'RESULT fail-on-dead ACCEPTED (BAD)'; exception when others then raise notice 'RESULT fail-on-dead rejected'; end;
  perform public.revive_scoring_job(v_job);
  select status,failure_count into v_status,v_fc from public.scoring_job_state where id=v_job;
  raise notice 'RESULT revived -> status=% fc=% (expect pending,0)', v_status, v_fc;
end $blk$;
rollback to s;

\echo '######## J. PROMOTION: snapshot-based, exact included_in_generation, threshold change ########'
savepoint s;
do $blk$
declare v_rp uuid; v_sim uuid; v_real uuid; v_req uuid; v_job uuid; v_scores jsonb; v_cur uuid;
        v_leg_inc boolean; v_inc_after boolean;
begin
  -- a legacy post whose simulated result was NOT included (overall < 50), so we can
  -- prove threshold changes don't alter the stored historical boolean
  select ap.raw_post_id, ap.current_result_id, ap.included_in_generation
    into v_rp, v_sim, v_leg_inc
  from public.analyzed_posts ap join public.scoring_results sr on sr.id=ap.current_result_id
  where sr.source='simulated' and ap.included_in_generation=false limit 1;

  v_req := pg_temp.mk_request(); perform public.activate_scoring_request(v_req);
  v_job := public.enqueue_scoring_job(v_rp, v_req);
  perform public.complete_scoring_job(v_job,(select msg_id from public.scoring_job_state where id=v_job),v_rp,v_req,
    '{"sustainability":90,"innovation":20,"talent_development":5,"food_safety":9,"supply_chain":7,"tradition":4}'::jsonb,'r');
  select id into v_real from public.scoring_results where raw_post_id=v_rp and scoring_request_id=v_req;

  select current_result_id into v_cur from public.analyzed_posts where raw_post_id=v_rp;
  raise notice 'RESULT after completion current still simulated=% (expect t)', (v_cur=v_sim);

  perform public.set_current_scoring_result(v_rp, v_real);
  select relevance_scores, current_result_id into v_scores, v_cur from public.analyzed_posts where raw_post_id=v_rp;
  raise notice 'RESULT promoted real=% label innovation present=% (expect t,t)', (v_cur=v_real), (v_scores ? 'innovation');

  -- rename live label; older result projection must be invariant
  update public.scoring_themes set label='RENAMED_INNOVATION' where theme_id='innovation';
  perform public.set_current_scoring_result(v_rp, v_sim);
  perform public.set_current_scoring_result(v_rp, v_real);
  select relevance_scores into v_scores from public.analyzed_posts where raw_post_id=v_rp;
  raise notice 'RESULT after rename projection uses snapshot: innovation=% RENAMED=% (expect t,f)', (v_scores ? 'innovation'), (v_scores ? 'RENAMED_INNOVATION');

  -- change the CURRENT threshold, roll back to legacy: stored boolean must be restored exactly
  update public.configurations set min_relevance_score=0 where id='default';   -- would flip a derived value
  perform public.set_current_scoring_result(v_rp, v_sim);
  select included_in_generation into v_inc_after from public.analyzed_posts where raw_post_id=v_rp;
  raise notice 'RESULT rollback to legacy restores stored included=% (legacy was %) (expect equal, both f)', v_inc_after, v_leg_inc;

  begin perform public.set_current_scoring_result((select id from public.raw_posts where id<>v_rp limit 1), v_real);
        raise notice 'RESULT cross-post promote ACCEPTED (BAD)'; exception when others then raise notice 'RESULT cross-post promote rejected'; end;
end $blk$;
rollback to s;

\echo '######## K. FIX 6: theme_id immutable, label mutable ########'
savepoint s;
do $blk$
begin
  begin update public.scoring_themes set label='Sustainability (new)' where theme_id='sustainability'; raise notice 'RESULT label rename accepted (expect this)'; exception when others then raise notice 'RESULT label rename REJECTED (BAD): %', sqlerrm; end;
  begin update public.scoring_themes set theme_id='sustainability2' where theme_id='sustainability'; raise notice 'RESULT theme_id change ACCEPTED (BAD)'; exception when others then raise notice 'RESULT theme_id change rejected'; end;
end $blk$;
rollback to s;

\echo '######## L. scoring_requests immutable definition ########'
savepoint s;
do $blk$
declare v_req uuid;
begin
  v_req := pg_temp.mk_request();
  begin perform public.activate_scoring_request(v_req); raise notice 'RESULT status change (draft->active) accepted (expect this)'; exception when others then raise notice 'RESULT status change REJECTED (BAD)'; end;
  begin update public.scoring_requests set model='other' where id=v_req; raise notice 'RESULT definition change ACCEPTED (BAD)'; exception when others then raise notice 'RESULT definition change rejected'; end;
end $blk$;
rollback to s;

\echo '######## M. RLS ########'
select relname, relrowsecurity from pg_class
where relnamespace='public'::regnamespace
  and relname in ('scoring_themes','scoring_requests','scoring_results','scoring_job_state','scoring_dead_letter') order by 1;

rollback;

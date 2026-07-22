-- Phase 2 database verification. Runs inside a transaction that always rolls
-- back, so it is safe against a loaded local database.
--   psql "$DB_URL" -f scripts/verify_ingest.sql
--
-- Each DO block is wrapped in its own savepoint: a block that deliberately
-- leaves a source claimed as 'running' must not collide with the next block.
\pset pager off
\set ON_ERROR_STOP off
begin;

\echo '######## A. PRIVILEGES - must return ZERO rows ########'
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('ingest_runs','ingest_run_sources','raw_post_content_changes')
  and (grantee = 'anon'
       or (grantee = 'authenticated'
           and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES')));

\echo '-- authenticated holds SELECT and nothing else (expect 3 rows, all SELECT) --'
select table_name, privilege_type from information_schema.role_table_grants
where table_schema='public' and grantee='authenticated'
  and table_name in ('ingest_runs','ingest_run_sources','raw_post_content_changes')
order by 1;

\echo '-- RLS enabled on all three (expect t,t,t) --'
select relname, relrowsecurity from pg_class
where relnamespace='public'::regnamespace
  and relname in ('ingest_runs','ingest_run_sources','raw_post_content_changes') order by 1;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated','admin@cues.test','x',now(),now(),now()),
       ('00000000-0000-0000-0000-000000000000','22222222-2222-2222-2222-222222222222','authenticated','authenticated','outsider@cues.test','x',now(),now(),now());
insert into public.editors (user_id, email, full_name, role)
values ('11111111-1111-1111-1111-111111111111','admin@cues.test','Admin','admin');

\echo '######## B. ACCESS ########'
insert into public.ingest_runs (trigger_source, triggered_by, triggered_by_email)
values ('manual','11111111-1111-1111-1111-111111111111','admin@cues.test');

set local role anon;
savepoint s; select 'anon ingest_runs' k, count(*) from public.ingest_runs;               rollback to s;
savepoint s; select 'anon run_sources' k, count(*) from public.ingest_run_sources;        rollback to s;
savepoint s; select 'anon changes'     k, count(*) from public.raw_post_content_changes;  rollback to s;
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
savepoint s; select 'outsider ingest_runs (expect 0)' k, count(*) from public.ingest_runs; rollback to s;
reset role; reset request.jwt.claims;

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
savepoint s; select 'admin ingest_runs (expect 1)' k, count(*) from public.ingest_runs;   rollback to s;
\echo '-- editor writes must all fail --'
savepoint s; insert into public.ingest_runs (trigger_source) values ('cron');             rollback to s;
savepoint s; update public.ingest_runs set status='completed';                            rollback to s;
savepoint s; delete from public.ingest_runs;                                              rollback to s;
savepoint s; truncate public.ingest_runs cascade;                                         rollback to s;
savepoint s; insert into public.raw_post_content_changes (raw_post_id, stored_content_hash, observed_content_hash, observed_post_text) values ((select id from public.raw_posts limit 1),'a','b','x'); rollback to s;
reset role; reset request.jwt.claims;

\echo '######## C. CONSTRAINTS ########'
\echo '-- running row WITH finished_at must fail --'
savepoint s; insert into public.ingest_runs (trigger_source, status, finished_at) values ('cron','running',now()); rollback to s;
\echo '-- terminal row WITHOUT finished_at must fail --'
savepoint s; insert into public.ingest_runs (trigger_source, status) values ('cron','completed'); rollback to s;
\echo '-- lookback out of range must fail (0, 91) --'
savepoint s; insert into public.ingest_runs (trigger_source, lookback_days_override) values ('cron',0);  rollback to s;
savepoint s; insert into public.ingest_runs (trigger_source, lookback_days_override) values ('cron',91); rollback to s;
\echo '-- lookback 1 and 90 must succeed --'
savepoint s; insert into public.ingest_runs (trigger_source, lookback_days_override) values ('cron',1);  rollback to s;
savepoint s; insert into public.ingest_runs (trigger_source, lookback_days_override) values ('cron',90); rollback to s;
\echo '-- deleting the auth user must NOT break historical manual runs --'
savepoint s;
  delete from public.editors where user_id='11111111-1111-1111-1111-111111111111';
  delete from auth.users where id='11111111-1111-1111-1111-111111111111';
  select 'run survives' k, triggered_by is null as user_nulled, triggered_by_email
  from public.ingest_runs limit 1;
rollback to s;

\echo '######## D. CONCURRENCY GUARD ########'
savepoint sd;
do $blk$
declare
  r1 uuid; r2 uuid; s1 uuid; s2 uuid; ok1 boolean; ok2 boolean; ok3 boolean;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r1;
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r2;
  select id into s1 from public.sources order by name limit 1;
  select id into s2 from public.sources order by name desc limit 1;

  ok1 := public.claim_source_for_ingest(r1, s1, 'src1', 'https://x');
  ok2 := public.claim_source_for_ingest(r2, s1, 'src1', 'https://x');
  ok3 := public.claim_source_for_ingest(r2, s2, 'src2', 'https://y');
  raise notice 'RESULT claim: first=% second-same-source=% other-source=% (expect t,f,t)', ok1, ok2, ok3;

  update public.ingest_run_sources set started_at = now() - interval '1 hour'
   where run_id = r1 and source_id = s1;
  ok1 := public.claim_source_for_ingest(r2, s1, 'src1', 'https://x', '15 minutes');
  raise notice 'RESULT after stale reap, re-claim=% (expect t)', ok1;
  raise notice 'RESULT reaped row=% (expect failed/stale_lock)',
    (select status||'/'||coalesce(error_code,'-') from public.ingest_run_sources where run_id=r1 and source_id=s1);
end
$blk$;
rollback to sd;

\echo '######## E. FINALIZER ########'
savepoint se;
do $blk$
declare r uuid; s1 uuid; s2 uuid; st text;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  select id into s1 from public.sources order by name limit 1;
  select id into s2 from public.sources order by name desc limit 1;

  insert into public.ingest_run_sources (run_id, source_id, source_name, status, finished_at, provider_requests, pages_fetched, posts_inserted)
  values (r, s1, 'a', 'ok', now(), 4, 2, 7);
  insert into public.ingest_run_sources (run_id, source_id, source_name, status)
  values (r, s2, 'b', 'running');

  st := public.finalize_ingest_run(r);
  raise notice 'RESULT finalize with a running child = % (expect NULL)', coalesce(st,'NULL');

  update public.ingest_run_sources set status='failed', finished_at=now(), provider_requests=3
   where run_id=r and source_id=s2;
  st := public.finalize_ingest_run(r);
  raise notice 'RESULT finalize mixed ok+failed = % (expect completed_with_errors)', st;
  raise notice 'RESULT totals: provider_requests=% (expect 7) posts_inserted=% (expect 7) ok=% failed=%',
    (select provider_requests from public.ingest_runs where id=r),
    (select posts_inserted    from public.ingest_runs where id=r),
    (select sources_ok        from public.ingest_runs where id=r),
    (select sources_failed    from public.ingest_runs where id=r);
end
$blk$;
rollback to se;

\echo '-- all sources failed -> run status failed --'
savepoint se2;
do $blk$
declare r uuid; s1 uuid; st text;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  select id into s1 from public.sources order by name limit 1;
  insert into public.ingest_run_sources (run_id, source_id, source_name, status, finished_at)
  values (r, s1, 'a', 'failed', now());
  st := public.finalize_ingest_run(r);
  raise notice 'RESULT all-failed run = % (expect failed)', st;
end
$blk$;
rollback to se2;

\echo '######## E3. FINALIZER STATUS MATRIX FOR OPERATIONAL SKIPS ########'
savepoint sm;
do $blk$
declare
  r uuid; s1 uuid; s2 uuid; st text;
  -- code, whether a second source succeeded, expected run status
  cases text[][] := array[
    ['locked','no','failed'],
    ['locked','yes','completed_with_errors'],
    ['no_rapidapi_identifier','no','failed'],
    ['no_rapidapi_identifier','yes','completed_with_errors'],
    ['auth_aborted','no','failed'],
    ['auth_aborted','yes','completed_with_errors'],
    ['budget_exhausted','no','failed'],
    ['budget_exhausted','yes','completed_with_errors'],
    ['disabled','no','completed'],
    ['disabled','yes','completed']
  ];
  c text[];
begin
  select id into s1 from public.sources order by name limit 1;
  select id into s2 from public.sources order by name desc limit 1;

  foreach c slice 1 in array cases loop
    insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
    insert into public.ingest_run_sources (run_id, source_id, source_name, status, error_code, finished_at)
    values (r, s1, 'skipped-one', 'skipped', c[1], now());
    if c[2] = 'yes' then
      insert into public.ingest_run_sources (run_id, source_id, source_name, status, finished_at)
      values (r, s2, 'ok-one', 'ok', now());
    end if;

    st := public.finalize_ingest_run(r);
    if st is distinct from c[3] then
      raise notice 'RESULT % (success=%) -> % BUT EXPECTED %', c[1], c[2], st, c[3];
    else
      raise notice 'RESULT % (success=%) -> % (expected)', c[1], c[2], st;
    end if;
  end loop;
end
$blk$;
rollback to sm;

\echo '######## E2. REAPER: crashed function leaves stale claim AND stale run ########'
savepoint sr;
do $blk$
declare r uuid; s1 uuid; rec record;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  select id into s1 from public.sources order by name limit 1;
  insert into public.ingest_run_sources (run_id, source_id, source_name, status)
  values (r, s1, 'a', 'running');
  update public.ingest_runs        set started_at = now() - interval '1 hour' where id = r;
  update public.ingest_run_sources set started_at = now() - interval '1 hour' where run_id = r;

  select * into rec from public.reap_stale_ingest('15 minutes');
  raise notice 'RESULT reaper: sources=% runs=% (expect 1,1)', rec.reaped_sources, rec.finalized_runs;
  raise notice 'RESULT parent run: status=% finished=% (expect failed,t)',
    (select status from public.ingest_runs where id=r),
    (select finished_at is not null from public.ingest_runs where id=r);
  raise notice 'RESULT child: status=%/% (expect failed/stale_lock)',
    (select status from public.ingest_run_sources where run_id=r),
    (select error_code from public.ingest_run_sources where run_id=r);
end
$blk$;
rollback to sr;

\echo '-- crashed before claiming anything: run must still close --'
savepoint sr2;
do $blk$
declare r uuid; rec record;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  update public.ingest_runs set started_at = now() - interval '1 hour' where id = r;
  select * into rec from public.reap_stale_ingest('15 minutes');
  raise notice 'RESULT orphan run: status=% finished=% (expect failed,t)',
    (select status from public.ingest_runs where id=r),
    (select finished_at is not null from public.ingest_runs where id=r);
end
$blk$;
rollback to sr2;

\echo '######## F. CONTENT CHANGE ########'
savepoint sf;
do $blk$
declare rp uuid; r uuid; c1 boolean; c2 boolean; c3 boolean;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  select id into rp from public.raw_posts limit 1;

  c1 := public.record_content_change(rp, r, (select post_text from public.raw_posts where id=rp));
  raise notice 'RESULT identical text -> % (expect f)', c1;

  c2 := public.record_content_change(rp, r, 'EDITED VERSION ONE');
  c3 := public.record_content_change(rp, r, 'EDITED VERSION ONE');
  raise notice 'RESULT changed=% repeat=% (expect t,t)', c2, c3;
  raise notice 'RESULT dedup: rows=% observation_count=% (expect 1,2)',
    (select count(*) from public.raw_post_content_changes where raw_post_id=rp),
    (select observation_count from public.raw_post_content_changes where raw_post_id=rp);

  perform public.record_content_change(rp, r, 'EDITED VERSION TWO');
  raise notice 'RESULT second distinct version -> rows=% (expect 2)',
    (select count(*) from public.raw_post_content_changes where raw_post_id=rp);

  raise notice 'RESULT raw_posts text untouched = % (expect t)',
    (select content_hash = md5(post_text) and post_text not like 'EDITED%' from public.raw_posts where id=rp);

  update public.raw_post_content_changes set resolved_at=now(), resolution='dismissed'
   where raw_post_id=rp and observed_content_hash=md5('EDITED VERSION ONE');
  perform public.record_content_change(rp, r, 'EDITED VERSION ONE');
  raise notice 'RESULT resolve then re-see -> rows for v1 = % (expect 2: one closed, one open)',
    (select count(*) from public.raw_post_content_changes
      where raw_post_id=rp and observed_content_hash=md5('EDITED VERSION ONE'));
end
$blk$;
rollback to sf;

\echo '-- resolution/resolved_at must move together (both must ERROR) --'
savepoint sf2;
  insert into public.raw_post_content_changes (raw_post_id, stored_content_hash, observed_content_hash, observed_post_text)
  values ((select id from public.raw_posts limit 1), 'aaa', 'bbb', 'x');
  savepoint s; update public.raw_post_content_changes set resolved_at=now();    rollback to s;
  savepoint s; update public.raw_post_content_changes set resolution='applied'; rollback to s;
rollback to sf2;

\echo '######## G. MISC CONSTRAINTS ########'
\echo '-- provider_requests < pages_fetched must fail --'
savepoint sg;
do $blk$
declare r uuid;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  begin
    insert into public.ingest_run_sources (run_id, source_id, source_name, status, finished_at, provider_requests, pages_fetched)
    values (r, (select id from public.sources limit 1), 'x', 'ok', now(), 1, 5);
    raise notice 'RESULT requests<pages ACCEPTED (BAD)';
  exception when check_violation then
    raise notice 'RESULT requests<pages rejected (expect this)';
  end;
end
$blk$;
rollback to sg;

\echo '-- a source referenced by run history cannot be deleted --'
savepoint sh;
do $blk$
declare r uuid; s1 uuid;
begin
  insert into public.ingest_runs (trigger_source) values ('cron') returning id into r;
  select id into s1 from public.sources order by name limit 1;
  insert into public.ingest_run_sources (run_id, source_id, source_name, status, finished_at)
  values (r, s1, 'a', 'ok', now());
  begin
    delete from public.sources where id = s1;
    raise notice 'RESULT source delete ACCEPTED (BAD)';
  exception
    when foreign_key_violation then raise notice 'RESULT source delete RESTRICTed (expect this)';
  end;
end
$blk$;
rollback to sh;

rollback;

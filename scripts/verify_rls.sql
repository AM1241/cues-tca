\pset pager off
\set ON_ERROR_STOP off
begin;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated','editor@cues.test','x',now(),now(),now()),
       ('00000000-0000-0000-0000-000000000000','22222222-2222-2222-2222-222222222222','authenticated','authenticated','outsider@cues.test','x',now(),now(),now());
insert into public.editors (user_id, email, full_name) values ('11111111-1111-1111-1111-111111111111','editor@cues.test','Test Editor');

\echo '################ 1. ANON — must read NOTHING ################'
set local role anon;
savepoint s; select 'anon raw_posts'      k, count(*) from public.raw_posts;                rollback to s;
savepoint s; select 'anon analyzed'       k, count(*) from public.analyzed_posts;           rollback to s;
savepoint s; select 'anon anonymized'     k, count(*) from public.anonymized_posts_current; rollback to s;
savepoint s; select 'anon assets'         k, count(*) from public.editorial_assets;         rollback to s;
savepoint s; select 'anon sources'        k, count(*) from public.sources;                  rollback to s;
savepoint s; select 'anon config'         k, count(*) from public.configurations;           rollback to s;
savepoint s; select 'anon editors'        k, count(*) from public.editors;                  rollback to s;
savepoint s; select 'anon trace'          k, count(*) from public.traceability_links;       rollback to s;
reset role;

\echo '################ 2. AUTHENTICATED but NOT on allowlist — must read NOTHING ################'
set local role authenticated;
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
savepoint s; select 'is_editor()'         k, public.is_editor()::text;                      rollback to s;
savepoint s; select 'outsider raw_posts'  k, count(*) from public.raw_posts;                rollback to s;
savepoint s; select 'outsider assets'     k, count(*) from public.editorial_assets;         rollback to s;
savepoint s; select 'outsider config'     k, count(*) from public.configurations;           rollback to s;
savepoint s; select 'outsider sources'    k, count(*) from public.sources;                  rollback to s;
savepoint s; insert into public.sources (name, source_type, url) values ('Hack','linkedin','u'); rollback to s;
reset role; reset request.jwt.claims;

\echo '################ 3. EDITOR on allowlist — must READ ALL ################'
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
savepoint s; select 'is_editor()'         k, public.is_editor()::text;                      rollback to s;
savepoint s; select 'editor raw_posts'    k, count(*) from public.raw_posts;                rollback to s;
savepoint s; select 'editor analyzed'     k, count(*) from public.analyzed_posts;           rollback to s;
savepoint s; select 'editor anonymized'   k, count(*) from public.anonymized_posts_current; rollback to s;
savepoint s; select 'editor assets'       k, count(*) from public.editorial_assets;         rollback to s;
savepoint s; select 'editor trace_links'  k, count(*) from public.traceability_links;       rollback to s;
savepoint s; select 'editor link_posts'   k, count(*) from public.traceability_link_posts;  rollback to s;
savepoint s; select 'editor config'       k, count(*) from public.configurations;           rollback to s;
savepoint s; select 'editor sources'      k, count(*) from public.sources;                  rollback to s;

\echo '--- writes an editor SHOULD be able to do (expect success) ---'
savepoint s; update public.configurations set min_relevance_score=55 where id='default';                                 rollback to s;
savepoint s; update public.editorial_assets set status='approved' where id=(select id from public.editorial_assets limit 1); rollback to s;
savepoint s; insert into public.sources (name,source_type,url) values ('Test Source','linkedin','https://example.com');  rollback to s;
savepoint s; delete from public.sources where name='European Commission LinkedIn';                                        rollback to s;

\echo '--- writes an editor must NOT be able to do (expect ERROR) ---'
savepoint s; insert into public.raw_posts (source_id,source_url,post_text,published_at) values ((select id from public.sources limit 1),'u','t',now()); rollback to s;
savepoint s; update public.raw_posts set post_text='tampered';                                                            rollback to s;
savepoint s; delete from public.analyzed_posts;                                                                           rollback to s;
savepoint s; update public.anonymized_posts_current set anonymized_text='tampered';                                       rollback to s;
savepoint s; insert into public.editorial_assets (generation_id,asset_type,generated_text) values ((select id from public.generation_requests limit 1),'post','x'); rollback to s;
savepoint s; delete from public.editorial_assets;                                                                         rollback to s;
savepoint s; delete from public.configurations where id='default';                                                        rollback to s;
savepoint s; insert into public.configurations (id) values ('default');                                                   rollback to s;
savepoint s; insert into public.editors (user_id,email) values ('22222222-2222-2222-2222-222222222222','o@x.test');       rollback to s;
savepoint s; update public.editors set role='admin';                                                                      rollback to s;
savepoint s; delete from public.traceability_links;                                                                       rollback to s;

\echo '--- provenance constraint must still bite (expect ERROR) ---'
savepoint s; update public.editorial_assets set llm_used=true where provenance='legacy_unverified';                       rollback to s;
savepoint s; update public.editorial_assets set provenance='llm_verified' where provenance='simulated_fallback';          rollback to s;
reset role; reset request.jwt.claims;

\echo '################ 4. SERVICE ROLE — must do everything ################'
set local role service_role;
savepoint s; select 'service raw_posts'   k, count(*) from public.raw_posts;                rollback to s;
savepoint s; select 'service assets'      k, count(*) from public.editorial_assets;         rollback to s;
savepoint s; insert into public.raw_posts (source_id,source_url,post_text,published_at) values ((select id from public.sources limit 1),'u','svc test',now()); rollback to s;
savepoint s; insert into public.editors (user_id,email) values ('22222222-2222-2222-2222-222222222222','o@x.test');       rollback to s;
savepoint s; update public.configurations set min_relevance_score=60;                                                     rollback to s;
reset role;

rollback;

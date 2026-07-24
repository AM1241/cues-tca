-- =============================================================================
-- 0014_anonymize_schema.sql — Phase 4: anonymisation queue + append-only results
-- =============================================================================
--
-- See docs/PHASE4_REQUIREMENTS.md for the confirmed product spec. This
-- migration reuses the score-worker architecture (0005/0009): a pgmq queue,
-- lease/processing_token claiming, append-only results, SECURITY DEFINER
-- RPC-only writes. It deliberately does NOT reuse scoring's "immutable
-- request" concept — anonymisation has no run-level definition shared by many
-- jobs, so there is no anonymize_requests table, no request-first lock
-- ordering, and no circuit-break: each post's entity-extraction call is
-- independent, so one client error does not imply its siblings will fail the
-- same way.
--
-- Job creation is manual-only (backfill_anonymize_jobs), not an insert
-- trigger on raw_posts: anonymisation depends on scoring having already run
-- (CLAUDE.md pipeline order), and auto-enqueuing on every scored post would
-- start paying for entity-extraction calls before an operator asks for them.
-- This matches the product's on-demand/button-triggered philosophy literally.
--
-- Failure mode is fail-loud (PHASE4_REQUIREMENTS.md §1): a failed job never
-- writes anonymized_posts_current under a success state. No circuit-break
-- tier is needed for that guarantee here — completion only ever happens via
-- complete_anonymize_job, which only runs after Stage 2 (LLM entity
-- extraction) succeeded in the worker.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- anonymize_results — append-only history (mirrors scoring_results)
-- -----------------------------------------------------------------------------
create table public.anonymize_results (
  id                       uuid primary key default gen_random_uuid(),
  raw_post_id              uuid not null references public.raw_posts (id) on delete restrict,

  source_name              text not null,
  generalized_source_name  text not null,
  overall_relevance        numeric(5,2) not null
                             check (overall_relevance >= 0 and overall_relevance <= 100),
  anonymized_text          text not null,
  replacements             jsonb not null default '[]'::jsonb,

  -- Was the LLM entity-extraction pass actually invoked and did it succeed?
  -- Mirrors scoring_results.llm_used: a completed result only ever exists
  -- when this is true — a failed extraction dead-letters the job instead of
  -- writing a false/partial result (see 0014's fail-loud completion RPC).
  entity_extraction_used   boolean not null,

  config_snapshot          jsonb not null default '{}'::jsonb,
  config_hash              text not null,
  anonymize_job_id         uuid,
  provider_response        jsonb,

  idempotency_key          text not null unique,
  created_at                timestamptz not null default now()
);

comment on column public.anonymize_results.replacements is
  'Merged audit trail: deterministic (source-name/public-body) + LLM entity-extraction findings.';
comment on column public.anonymize_results.entity_extraction_used is
  'True only for a completed result — a failed LLM pass never reaches completion (fail-loud).';

create index anonymize_results_raw_post_idx on public.anonymize_results (raw_post_id, created_at desc);

-- Composite uniqueness on (id, raw_post_id) — id alone is already the primary
-- key and therefore already unique, but Postgres requires the referenced
-- columns of a composite foreign key to be covered by a single unique
-- constraint/index, not just each column unique on its own. This is what
-- lets 0015's post_embeddings / clustering_run_posts declare a composite FK
-- of the form (anonymize_result_id, raw_post_id) -> anonymize_results(id,
-- raw_post_id), so the database itself rejects a raw_post_id paired with a
-- DIFFERENT post's anonymize_result_id — not just an application-level
-- assumption that the two always travel together.
alter table public.anonymize_results
  add constraint anonymize_results_id_raw_post_id_uniq unique (id, raw_post_id);

-- Append-only: UPDATE/DELETE blocked for every caller, same as scoring_results.
create or replace function public.anonymize_results_immutable()
returns trigger language plpgsql as $$
begin raise exception 'anonymize_results is append-only (% blocked)', tg_op; end
$$;
create trigger anonymize_results_no_update before update on public.anonymize_results
  for each row execute function public.anonymize_results_immutable();
create trigger anonymize_results_no_delete before delete on public.anonymize_results
  for each row execute function public.anonymize_results_immutable();


-- -----------------------------------------------------------------------------
-- anonymized_posts_current — add an explicit pointer to its source result
-- -----------------------------------------------------------------------------
-- Table already exists (0001), overwrite-in-place. The legacy columns stay for
-- read compatibility; current_result_id makes the "current projection" pointer
-- explicit and traceable, mirroring analyzed_posts.current_result_id.
-- -----------------------------------------------------------------------------
alter table public.anonymized_posts_current
  add column current_result_id uuid references public.anonymize_results (id) on delete set null;


-- -----------------------------------------------------------------------------
-- anonymize_job_state — business retry state, one row per raw_post_id
-- -----------------------------------------------------------------------------
-- No scoring_request_id analogue: each post's job is independent, not grouped
-- under a shared immutable definition.
-- -----------------------------------------------------------------------------
create table public.anonymize_job_state (
  id                 uuid primary key default gen_random_uuid(),
  raw_post_id        uuid not null references public.raw_posts (id) on delete restrict,

  status             text not null default 'pending'
                       check (status in ('pending','processing','succeeded','dead_letter')),
  msg_id             bigint,
  processing_token   uuid,
  leased_at          timestamptz,

  failure_count      integer not null default 0 check (failure_count >= 0),
  last_failure_type  text,
  last_error_code    text,
  last_error_message text,
  next_attempt_at    timestamptz,

  enqueued_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One live job per post across its lifecycle.
create unique index anonymize_job_raw_post_uniq on public.anonymize_job_state (raw_post_id);
create index anonymize_job_status_idx on public.anonymize_job_state (status);


-- -----------------------------------------------------------------------------
-- anonymize_dead_letter — one record per job
-- -----------------------------------------------------------------------------
create table public.anonymize_dead_letter (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null unique,
  raw_post_id        uuid not null references public.raw_posts (id) on delete restrict,
  failure_type       text not null,
  error_code         text,
  error_message      text,
  provider_response  jsonb,
  attempts           integer not null,
  dead_lettered_at   timestamptz not null default now()
);


-- =============================================================================
-- Enqueue path — manual backfill only, no insert trigger (see header)
-- =============================================================================
create or replace function public.backfill_anonymize_jobs(p_min_relevance numeric default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_min numeric := coalesce(p_min_relevance,
    (select min_relevance_score from public.configurations where id = 'default'));
  v_count int := 0; r record; v_job_id uuid; v_msg_id bigint;
begin
  for r in
    select ap.raw_post_id
    from public.analyzed_posts ap
    left join public.anonymized_posts_current apc on apc.raw_post_id = ap.raw_post_id
    where ap.current_result_id is not null
      and ap.overall_relevance >= v_min
      and apc.current_result_id is null
      and not exists (
        select 1 from public.anonymize_job_state js
        where js.raw_post_id = ap.raw_post_id and js.status in ('pending','processing')
      )
  loop
    insert into public.anonymize_job_state (raw_post_id, status)
    values (r.raw_post_id, 'pending')
    on conflict (raw_post_id) do update
      set status = 'pending', failure_count = 0, last_failure_type = null,
          last_error_code = null, last_error_message = null, next_attempt_at = null,
          processing_token = null, leased_at = null, updated_at = now()
      where public.anonymize_job_state.status = 'dead_letter'
    returning id into v_job_id;

    if v_job_id is null then continue; end if;

    v_msg_id := pgmq.send('anonymize_jobs', jsonb_build_object(
      'job_id', v_job_id, 'raw_post_id', r.raw_post_id));
    update public.anonymize_job_state set msg_id = v_msg_id, updated_at = now() where id = v_job_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

comment on function public.backfill_anonymize_jobs(numeric) is
  'Enqueues eligible scored-but-not-yet-anonymised posts. Explicit/manual only — no auto-enqueue trigger.';


-- =============================================================================
-- Claim — atomic lease via processing_token (mirrors read_scoring_jobs, 0009)
-- =============================================================================
create or replace function public.read_anonymize_jobs(p_vt integer, p_qty integer)
returns table (msg_id bigint, message jsonb, processing_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; v_token uuid;
begin
  for r in select m.msg_id, m.message from pgmq.read('anonymize_jobs', p_vt, p_qty) m loop
    v_token := gen_random_uuid();
    update public.anonymize_job_state
       set processing_token = v_token, status = 'processing',
           leased_at = now(), msg_id = r.msg_id, updated_at = now()
     where id = (r.message ->> 'job_id')::uuid
       and status in ('pending', 'processing');
    if found then
      msg_id := r.msg_id; message := r.message; processing_token := v_token;
      return next;
    else
      -- Orphan message: job row gone or already terminal. Archive so it's not
      -- re-read forever.
      perform pgmq.archive('anonymize_jobs', r.msg_id);
    end if;
  end loop;
end
$$;


-- =============================================================================
-- Completion — fail-loud: only ever called after a successful entity pass
-- =============================================================================
create or replace function public.complete_anonymize_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid,
  p_anonymized_text text, p_replacements jsonb, p_generalized_source_name text,
  p_entity_extraction_used boolean, p_config_snapshot jsonb,
  p_provider_response jsonb default null, p_processing_token uuid default null
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

  -- Lease check: a stale invocation whose job was reclaimed returns benignly.
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
    config_snapshot, config_hash, anonymize_job_id, provider_response, idempotency_key
  ) values (
    p_raw_post_id, v_source_name, p_generalized_source_name, v_overall,
    p_anonymized_text, coalesce(p_replacements, '[]'::jsonb), true,
    p_config_snapshot, v_hash, p_job_id, p_provider_response, v_idk
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


-- =============================================================================
-- Failure / dead-letter — 3-strike backoff, no circuit-break tier (see header)
-- =============================================================================
create or replace function public.dead_letter_anonymize_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb, p_attempts integer
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_job public.anonymize_job_state%rowtype;
begin
  select * into v_job from public.anonymize_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;
  if v_job.status = 'succeeded' then raise exception 'cannot dead-letter a succeeded job'; end if;

  insert into public.anonymize_dead_letter (
    job_id, raw_post_id, failure_type, error_code, error_message, provider_response, attempts
  ) values (
    p_job_id, p_raw_post_id, p_failure_type, p_error_code, p_error_message, p_provider_response, p_attempts
  )
  on conflict (job_id) do update
    set failure_type = excluded.failure_type, error_code = excluded.error_code,
        error_message = excluded.error_message, provider_response = excluded.provider_response,
        attempts = excluded.attempts, dead_lettered_at = now();

  update public.anonymize_job_state
     set status = 'dead_letter', last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;
  if p_msg_id is not null then perform pgmq.archive('anonymize_jobs', p_msg_id); end if;
end
$$;

create or replace function public.record_anonymize_failure(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid,
  p_failure_type text, p_error_code text, p_error_message text,
  p_provider_response jsonb default null, p_processing_token uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_job public.anonymize_job_state%rowtype; v_fc int; v_backoff int;
begin
  select * into v_job from public.anonymize_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;

  if v_job.processing_token is distinct from p_processing_token then return 'superseded'; end if;
  if v_job.status not in ('pending','processing') then return 'superseded'; end if;

  v_fc := v_job.failure_count + 1;
  update public.anonymize_job_state
     set failure_count = v_fc, last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;

  if v_fc >= 3 then
    perform public.dead_letter_anonymize_job(
      p_job_id, p_msg_id, p_raw_post_id,
      'exhausted', p_error_code, coalesce(p_error_message, p_failure_type), p_provider_response, v_fc);
    return 'dead_letter';
  end if;

  v_backoff := case v_fc when 1 then 30 when 2 then 120 else 120 end;   -- server-authoritative
  update public.anonymize_job_state
     set next_attempt_at = now() + make_interval(secs => v_backoff), status = 'pending',
         processing_token = null, updated_at = now()
   where id = p_job_id;
  if p_msg_id is not null then perform pgmq.set_vt('anonymize_jobs', p_msg_id, v_backoff); end if;
  return 'retry';
end
$$;


-- =============================================================================
-- configurations — new clustering knobs (Phase 4 §3; landed here per checkpoint
-- review so both new columns live in one migration alongside the rest of
-- Phase 4's schema work)
-- =============================================================================
alter table public.configurations
  add column cluster_similarity_threshold numeric(3,2) not null default 0.75
    check (cluster_similarity_threshold > 0 and cluster_similarity_threshold <= 1),
  add column min_cluster_size integer not null default 2
    check (min_cluster_size >= 1);

comment on column public.configurations.cluster_similarity_threshold is
  'Cosine-similarity cutoff for grouping posts into a cluster. Snapshotted per clustering_runs row.';
comment on column public.configurations.min_cluster_size is
  'Buckets smaller than this are dropped. Snapshotted per clustering_runs row.';


-- =============================================================================
-- Privileges — SELECT + controlled RPCs; no direct DML on the trusted tables
-- =============================================================================
alter table public.anonymize_results     enable row level security;
alter table public.anonymize_job_state   enable row level security;
alter table public.anonymize_dead_letter enable row level security;

revoke all on public.anonymize_results     from anon, authenticated;
revoke all on public.anonymize_job_state   from anon, authenticated;
revoke all on public.anonymize_dead_letter from anon, authenticated;

grant select on public.anonymize_results     to authenticated;
grant select on public.anonymize_job_state   to authenticated;
grant select on public.anonymize_dead_letter to authenticated;

grant select on public.anonymize_results     to service_role;
grant select on public.anonymize_job_state   to service_role;
grant select on public.anonymize_dead_letter to service_role;

revoke truncate, trigger, references on
  public.anonymize_results, public.anonymize_job_state, public.anonymize_dead_letter
  from service_role, authenticated, anon;

create policy anonymize_results_select_for_editors on public.anonymize_results
  for select to authenticated using ((select public.is_editor()));
create policy anonymize_job_state_select_for_editors on public.anonymize_job_state
  for select to authenticated using ((select public.is_editor()));
create policy anonymize_dead_letter_select_for_editors on public.anonymize_dead_letter
  for select to authenticated using ((select public.is_editor()));

-- RPC execute grants (service_role only).
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'backfill_anonymize_jobs(numeric)',
    'read_anonymize_jobs(integer,integer)',
    'complete_anonymize_job(uuid,bigint,uuid,text,jsonb,text,boolean,jsonb,jsonb,uuid)',
    'dead_letter_anonymize_job(uuid,bigint,uuid,text,text,text,jsonb,integer)',
    'record_anonymize_failure(uuid,bigint,uuid,text,text,text,jsonb,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end
$grants$;


-- =============================================================================
-- Migration tail: queue only. No jobs created.
-- =============================================================================
select pgmq.create('anonymize_jobs');

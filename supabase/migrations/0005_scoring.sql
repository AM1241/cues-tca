-- =============================================================================
-- 0005_scoring.sql — Phase 3B: scoring requests, queue, append-only results
-- =============================================================================
--
-- Schema + queue + legacy history only. NO worker, NO LLM call, and crucially
-- NO production scoring request and NO scored jobs are created here — the real
-- prompt and pinned model are chosen later (Phase 3C/3F), and a job is only
-- meaningful under an approved immutable request.
--
-- Authoritative model:
--   scoring_requests  — the IMMUTABLE definition of one logical scoring run
--                       (prompt, config snapshot, pinned model, aggregation).
--                       Only status transitions; the definition never changes.
--   scoring_job_state — references a scoring_request; carries no prompt/config
--                       of its own. Business retry state lives here.
--   scoring_results   — append-only history. A completed result copies its
--                       definition FROM the request; the worker cannot choose
--                       model/prompt/config/aggregation/source.
--   analyzed_posts    — the current projection, selected via current_result_id.
--
-- All writes to scoring_results / scoring_job_state / scoring_dead_letter go
-- through SECURITY DEFINER RPCs; those tables grant SELECT only to service_role.
--
-- 0001..0004 are on the cloud and untouched. This is additive.
-- =============================================================================

create extension if not exists pgmq;


-- -----------------------------------------------------------------------------
-- Stable theme identity — theme_id immutable, label/position/active mutable
-- -----------------------------------------------------------------------------
create table public.scoring_themes (
  theme_id   text primary key,
  label      text not null unique,
  position   integer not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.scoring_themes (theme_id, label, position) values
  ('sustainability',     'sustainability',     1),
  ('innovation',         'innovation',         2),
  ('talent_development', 'talent development',  3),
  ('food_safety',        'food safety',        4),
  ('supply_chain',       'supply chain',       5),
  ('tradition',          'tradition',          6);

-- theme_id may never change; the admin path may still relabel / reorder / retire.
create or replace function public.scoring_themes_guard()
returns trigger language plpgsql as $$
begin
  if new.theme_id <> old.theme_id then
    raise exception 'scoring_themes.theme_id is immutable';
  end if;
  return new;
end
$$;
create trigger scoring_themes_theme_id_immutable
  before update on public.scoring_themes
  for each row execute function public.scoring_themes_guard();


-- -----------------------------------------------------------------------------
-- Config / snapshot / validation helpers
-- -----------------------------------------------------------------------------
create or replace function public.scoring_prompt_version()
returns text language sql immutable as $$ select 'scoring_v1'::text $$;

create or replace function public.scoring_theme_snapshot()
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'theme_id', theme_id, 'label', label, 'position', position
         ) order by position), '[]'::jsonb)
  from public.scoring_themes where active
$$;

-- Convenience for BUILDING a request/config snapshot from the live config.
create or replace function public.scoring_config_snapshot()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'themes', public.scoring_theme_snapshot(),
    'min_relevance_score', (select min_relevance_score from public.configurations where id = 'default'),
    'prompt_version', public.scoring_prompt_version()
  )
$$;

create or replace function public.scoring_hash_of_snapshot(p_snapshot jsonb)
returns text language sql immutable as $$ select md5(p_snapshot::text) $$;

create or replace function public.scoring_apply_aggregation(p_strategy text, p_theme_scores jsonb)
returns numeric language plpgsql immutable as $$
declare v numeric;
begin
  if p_theme_scores is null or jsonb_typeof(p_theme_scores) <> 'object' or p_theme_scores = '{}'::jsonb then
    raise exception 'aggregation on empty theme_scores';
  end if;
  if p_strategy = 'max_theme_v1' then
    select max((value #>> '{}')::numeric) into v from jsonb_each(p_theme_scores);
    return v;
  end if;
  raise exception 'unknown aggregation_strategy %', p_strategy;
end
$$;

create or replace function public.validate_theme_scores(p_scores jsonb, p_snapshot jsonb)
returns void language plpgsql immutable as $$
declare k text; v jsonb; n numeric;
begin
  if p_scores is null or jsonb_typeof(p_scores) <> 'object' or p_scores = '{}'::jsonb then
    raise exception 'theme_scores empty or not an object';
  end if;
  if jsonb_typeof(p_snapshot -> 'themes') <> 'array' or jsonb_array_length(p_snapshot -> 'themes') = 0 then
    raise exception 'config snapshot has no themes';
  end if;
  if exists (select 1 from jsonb_array_elements(p_snapshot -> 'themes') t where not (p_scores ? (t ->> 'theme_id'))) then
    raise exception 'theme_scores is missing a required theme';
  end if;
  if exists (select 1 from jsonb_object_keys(p_scores) key
             where not exists (select 1 from jsonb_array_elements(p_snapshot -> 'themes') t where t ->> 'theme_id' = key)) then
    raise exception 'theme_scores has an unexpected theme';
  end if;
  for k, v in select key, value from jsonb_each(p_scores) loop
    if jsonb_typeof(v) <> 'number' then raise exception 'theme_scores.% is not numeric', k; end if;
    n := (v #>> '{}')::numeric;
    if n <> trunc(n) then raise exception 'theme_scores.% is not an integer', k; end if;
    if n < 0 or n > 100 then raise exception 'theme_scores.% out of range 0..100', k; end if;
  end loop;
end
$$;


-- -----------------------------------------------------------------------------
-- scoring_requests — the immutable definition of one logical scoring run
-- -----------------------------------------------------------------------------
create table public.scoring_requests (
  id                   uuid primary key default gen_random_uuid(),
  purpose              text not null check (purpose in ('production','evaluation','reevaluation')),
  prompt_version       text not null,
  prompt_hash          text not null,
  config_snapshot      jsonb not null,
  config_hash          text not null,
  model                text not null,
  model_snapshot       text not null check (length(model_snapshot) > 0),
  aggregation_strategy text not null check (aggregation_strategy in ('max_theme_v1')),
  status               text not null default 'draft' check (status in ('draft','active','closed')),
  created_at           timestamptz not null default now()
);

comment on table public.scoring_requests is
  'Immutable definition of one logical scoring run. Jobs and real results copy '
  'their prompt/config/model/aggregation from here; the worker cannot override them.';

-- At most one active production request at a time.
create unique index scoring_requests_one_active_production
  on public.scoring_requests (purpose)
  where purpose = 'production' and status = 'active';

-- The definition is immutable; only status transitions.
create or replace function public.scoring_requests_guard()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.purpose <> old.purpose or new.prompt_version <> old.prompt_version
     or new.prompt_hash <> old.prompt_hash or new.config_snapshot <> old.config_snapshot
     or new.config_hash <> old.config_hash or new.model <> old.model
     or new.model_snapshot <> old.model_snapshot or new.aggregation_strategy <> old.aggregation_strategy then
    raise exception 'scoring_requests definition is immutable; only status may change';
  end if;
  return new;
end
$$;
create trigger scoring_requests_immutable
  before update on public.scoring_requests
  for each row execute function public.scoring_requests_guard();


-- -----------------------------------------------------------------------------
-- scoring_results — append-only history (simulated + real)
-- -----------------------------------------------------------------------------
create table public.scoring_results (
  id                   uuid primary key default gen_random_uuid(),
  raw_post_id          uuid not null references public.raw_posts (id) on delete restrict,
  scoring_request_id   uuid references public.scoring_requests (id) on delete restrict,  -- null for legacy import

  source               text not null check (source in ('simulated','openai')),
  provenance_status    text not null check (provenance_status in ('legacy_unknown','llm_verified')),
  llm_used             boolean not null,
  model                text,
  model_snapshot       text,
  prompt_version       text,
  aggregation_strategy text not null,

  theme_scores         jsonb not null,
  overall_relevance    numeric(5,2) not null check (overall_relevance >= 0 and overall_relevance <= 100),
  reason               text,
  included_in_generation boolean not null,   -- stored, historical; never recomputed on read

  config_snapshot      jsonb not null,
  config_hash          text not null,
  scoring_job_id       uuid,
  provider_response    jsonb,

  idempotency_key      text not null unique,
  created_at           timestamptz not null default now(),

  constraint scoring_results_provenance_consistent check (
    (source = 'simulated' and provenance_status = 'legacy_unknown' and llm_used = false
      and model is null and model_snapshot is null and prompt_version is null
      and scoring_request_id is null)
    or
    (source = 'openai' and provenance_status = 'llm_verified' and llm_used = true
      and model is not null and model_snapshot is not null and length(model_snapshot) > 0
      and prompt_version is not null and length(prompt_version) > 0
      and scoring_request_id is not null)
  )
);

create index scoring_results_raw_post_idx on public.scoring_results (raw_post_id, created_at desc);
create index scoring_results_request_idx  on public.scoring_results (scoring_request_id);

-- Append-only: UPDATE/DELETE blocked for EVERY caller (fires even for SECURITY
-- DEFINER and superuser). TRUNCATE is closed for application roles via grants.
create or replace function public.scoring_results_immutable()
returns trigger language plpgsql as $$
begin raise exception 'scoring_results is append-only (% blocked)', tg_op; end
$$;
create trigger scoring_results_no_update before update on public.scoring_results
  for each row execute function public.scoring_results_immutable();
create trigger scoring_results_no_delete before delete on public.scoring_results
  for each row execute function public.scoring_results_immutable();


alter table public.analyzed_posts
  add column current_result_id uuid references public.scoring_results (id) on delete set null;


-- -----------------------------------------------------------------------------
-- scoring_job_state — references a request; carries business retry state only
-- -----------------------------------------------------------------------------
create table public.scoring_job_state (
  id                 uuid primary key default gen_random_uuid(),
  raw_post_id        uuid not null references public.raw_posts (id) on delete restrict,
  scoring_request_id uuid not null references public.scoring_requests (id) on delete restrict,

  status             text not null default 'pending'
                       check (status in ('pending','processing','succeeded','dead_letter')),
  msg_id             bigint,

  failure_count      integer not null default 0 check (failure_count >= 0),
  last_failure_type  text,
  last_error_code    text,
  last_error_message text,
  next_attempt_at    timestamptz,

  enqueued_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One logical job per (raw_post_id, scoring_request_id) across the whole lifecycle.
create unique index scoring_job_logical_uniq
  on public.scoring_job_state (raw_post_id, scoring_request_id);
create index scoring_job_status_idx on public.scoring_job_state (status);
create index scoring_job_raw_post_idx on public.scoring_job_state (raw_post_id);


-- -----------------------------------------------------------------------------
-- scoring_dead_letter — one record per job
-- -----------------------------------------------------------------------------
create table public.scoring_dead_letter (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null unique,
  raw_post_id        uuid not null references public.raw_posts (id) on delete restrict,
  scoring_request_id uuid not null references public.scoring_requests (id) on delete restrict,
  failure_type       text not null,
  error_code         text,
  error_message      text,
  provider_response  jsonb,
  attempts           integer not null,
  dead_lettered_at   timestamptz not null default now()
);


-- =============================================================================
-- Scoring request lifecycle
-- =============================================================================
create or replace function public.create_scoring_request(
  p_purpose text, p_prompt_version text, p_prompt_hash text, p_config_snapshot jsonb,
  p_model text, p_model_snapshot text, p_aggregation_strategy text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if jsonb_typeof(p_config_snapshot -> 'themes') <> 'array'
     or jsonb_array_length(p_config_snapshot -> 'themes') = 0
     or (p_config_snapshot ->> 'min_relevance_score') is null then
    raise exception 'config_snapshot must contain themes and min_relevance_score';
  end if;
  insert into public.scoring_requests (
    purpose, prompt_version, prompt_hash, config_snapshot, config_hash,
    model, model_snapshot, aggregation_strategy, status
  ) values (
    p_purpose, p_prompt_version, p_prompt_hash, p_config_snapshot,
    public.scoring_hash_of_snapshot(p_config_snapshot),
    p_model, p_model_snapshot, p_aggregation_strategy, 'draft'
  ) returning id into v_id;
  return v_id;
end
$$;

create or replace function public.activate_scoring_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  select status into v_status from public.scoring_requests where id = p_request_id for update;
  if not found then raise exception 'scoring_request % not found', p_request_id; end if;
  if v_status = 'closed' then raise exception 'cannot activate a closed request'; end if;
  update public.scoring_requests set status = 'active' where id = p_request_id;
end
$$;

create or replace function public.close_scoring_request(p_request_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.scoring_requests set status = 'closed' where id = p_request_id;
end
$$;


-- =============================================================================
-- Enqueue path — always under an active request
-- =============================================================================
create or replace function public.enqueue_scoring_job(p_raw_post_id uuid, p_scoring_request_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_status text; v_job_id uuid; v_msg_id bigint;
begin
  select status into v_status from public.scoring_requests where id = p_scoring_request_id;
  if not found then raise exception 'scoring_request % not found', p_scoring_request_id; end if;
  if v_status <> 'active' then raise exception 'scoring_request % is not active (status=%)', p_scoring_request_id, v_status; end if;

  insert into public.scoring_job_state (raw_post_id, scoring_request_id, status)
  values (p_raw_post_id, p_scoring_request_id, 'pending')
  on conflict (raw_post_id, scoring_request_id) do nothing
  returning id into v_job_id;

  if v_job_id is null then return null; end if;

  v_msg_id := pgmq.send('scoring_jobs', jsonb_build_object(
    'job_id', v_job_id, 'raw_post_id', p_raw_post_id, 'scoring_request_id', p_scoring_request_id));
  update public.scoring_job_state set msg_id = v_msg_id, updated_at = now() where id = v_job_id;
  return v_job_id;
end
$$;

-- Pipeline posts enqueue under the active PRODUCTION request, if one exists.
-- Before any request is activated (e.g. at migration apply), nothing enqueues.
create or replace function public.trg_enqueue_scoring_on_raw_post()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_req uuid;
begin
  if new.legacy_id is not null then return new; end if;
  select id into v_req from public.scoring_requests where purpose = 'production' and status = 'active' limit 1;
  if v_req is not null then perform public.enqueue_scoring_job(new.id, v_req); end if;
  return new;
end
$$;
create trigger raw_posts_enqueue_scoring
  after insert on public.raw_posts
  for each row execute function public.trg_enqueue_scoring_on_raw_post();

-- Enqueue genuinely unscored posts (no current projection, no existing job for
-- this request) under an active request. Does not touch the 133 simulated.
create or replace function public.backfill_scoring_for_request(p_request_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count int := 0; r record;
begin
  for r in
    select rp.id from public.raw_posts rp
    left join public.analyzed_posts ap on ap.raw_post_id = rp.id
    where ap.current_result_id is null
      and not exists (select 1 from public.scoring_job_state js
                      where js.raw_post_id = rp.id and js.scoring_request_id = p_request_id)
  loop
    if public.enqueue_scoring_job(r.id, p_request_id) is not null then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end
$$;

-- Explicit re-evaluation: enqueue EVERY raw post under a request (Phase 3G).
create or replace function public.enqueue_reevaluation(p_request_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count int := 0; r record;
begin
  for r in select id from public.raw_posts loop
    if public.enqueue_scoring_job(r.id, p_request_id) is not null then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end
$$;

-- The single explicit path Phase 3F uses: create + activate a production request
-- from an approved prompt/model, then backfill unscored posts. NOT called by the
-- migration.
create or replace function public.open_production_scoring_request(
  p_prompt_version text, p_prompt_hash text, p_config_snapshot jsonb,
  p_model text, p_model_snapshot text, p_aggregation_strategy text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  v_id := public.create_scoring_request('production', p_prompt_version, p_prompt_hash,
            p_config_snapshot, p_model, p_model_snapshot, p_aggregation_strategy);
  perform public.activate_scoring_request(v_id);
  perform public.backfill_scoring_for_request(v_id);
  return v_id;
end
$$;

create or replace function public.revive_scoring_job(p_job_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_job public.scoring_job_state%rowtype; v_msg bigint;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.status <> 'dead_letter' then raise exception 'only dead-lettered jobs can be revived (status=%)', v_job.status; end if;
  v_msg := pgmq.send('scoring_jobs', jsonb_build_object(
    'job_id', v_job.id, 'raw_post_id', v_job.raw_post_id, 'scoring_request_id', v_job.scoring_request_id));
  update public.scoring_job_state
     set status='pending', failure_count=0, last_failure_type=null, last_error_code=null,
         last_error_message=null, next_attempt_at=null, msg_id=v_msg, updated_at=now()
   where id = p_job_id;
end
$$;


-- =============================================================================
-- Legacy import — provenance legacy_unknown, exact included_in_generation
-- =============================================================================
create or replace function public.import_legacy_analyses()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_snap jsonb := jsonb_build_object(
    'themes', public.scoring_theme_snapshot(),
    'min_relevance_score', (select min_relevance_score from public.configurations where id = 'default'),
    'provenance', 'legacy_unknown');
  v_hash text := public.scoring_hash_of_snapshot(v_snap);
  v_count int := 0; ap record; v_theme_scores jsonb; v_result_id uuid; v_idk text;
begin
  for ap in
    select a.id, a.raw_post_id, a.relevance_scores, a.overall_relevance, a.reason_for_score, a.included_in_generation
    from public.analyzed_posts a where a.current_result_id is null
  loop
    select coalesce(jsonb_object_agg(t.theme_id, (ap.relevance_scores ->> t.label)), '{}'::jsonb)
      into v_theme_scores
    from public.scoring_themes t where ap.relevance_scores ? t.label;

    v_idk := 'legacy|' || ap.raw_post_id::text;

    insert into public.scoring_results (
      raw_post_id, scoring_request_id, source, provenance_status, llm_used,
      model, model_snapshot, prompt_version, aggregation_strategy,
      theme_scores, overall_relevance, reason, included_in_generation,
      config_snapshot, config_hash, idempotency_key
    ) values (
      ap.raw_post_id, null, 'simulated', 'legacy_unknown', false,
      null, null, null, 'legacy_import',
      v_theme_scores, ap.overall_relevance, ap.reason_for_score, ap.included_in_generation,  -- EXACT historical value
      v_snap, v_hash, v_idk
    )
    on conflict (idempotency_key) do nothing
    returning id into v_result_id;

    if v_result_id is null then
      select id into v_result_id from public.scoring_results where idempotency_key = v_idk;
    end if;
    update public.analyzed_posts set current_result_id = v_result_id, updated_at = now() where id = ap.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;


-- =============================================================================
-- Completion — definition comes from the request, not the worker
-- =============================================================================
create or replace function public.complete_scoring_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_theme_scores jsonb, p_reason text, p_provider_response jsonb default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.scoring_job_state%rowtype;
  v_req public.scoring_requests%rowtype;
  v_overall numeric; v_included boolean; v_idk text; v_result_id uuid;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id        <> p_raw_post_id        then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id           then raise exception 'msg_id mismatch'; end if;

  if v_job.status = 'succeeded' then return 'duplicate'; end if;
  if v_job.status not in ('pending','processing') then
    raise exception 'job % not completable (status=%)', p_job_id, v_job.status;
  end if;

  -- The immutable definition. Locked so it cannot be closed mid-completion.
  select * into v_req from public.scoring_requests where id = v_job.scoring_request_id for update;
  if not found then raise exception 'scoring_request % not found', v_job.scoring_request_id; end if;

  perform public.validate_theme_scores(p_theme_scores, v_req.config_snapshot);

  v_overall := public.scoring_apply_aggregation(v_req.aggregation_strategy, p_theme_scores);
  v_included := v_overall >= (v_req.config_snapshot ->> 'min_relevance_score')::numeric;

  -- Logical key: raw post + request id + the request's immutable definition.
  v_idk := md5(concat_ws('|', p_raw_post_id::text, p_scoring_request_id::text,
                 v_req.config_hash, v_req.model_snapshot, v_req.prompt_version, v_req.aggregation_strategy));

  insert into public.scoring_results (
    raw_post_id, scoring_request_id, source, provenance_status, llm_used,
    model, model_snapshot, prompt_version, aggregation_strategy,
    theme_scores, overall_relevance, reason, included_in_generation,
    config_snapshot, config_hash, scoring_job_id, provider_response, idempotency_key
  ) values (
    p_raw_post_id, v_req.id, 'openai', 'llm_verified', true,
    v_req.model, v_req.model_snapshot, v_req.prompt_version, v_req.aggregation_strategy,   -- FROM the request
    p_theme_scores, v_overall, p_reason, v_included,
    v_req.config_snapshot, v_req.config_hash, p_job_id, p_provider_response, v_idk
  )
  on conflict (idempotency_key) do nothing
  returning id into v_result_id;

  update public.scoring_job_state set status = 'succeeded', updated_at = now() where id = p_job_id;
  if p_msg_id is not null then perform pgmq.archive('scoring_jobs', p_msg_id); end if;

  return case when v_result_id is null then 'duplicate' else 'inserted' end;
end
$$;


-- =============================================================================
-- Failure / dead-letter — state-safe, server-side backoff
-- =============================================================================
create or replace function public.dead_letter_scoring_job(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb, p_attempts integer
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_job public.scoring_job_state%rowtype;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;
  if v_job.status = 'succeeded' then raise exception 'cannot dead-letter a succeeded job'; end if;

  insert into public.scoring_dead_letter (
    job_id, raw_post_id, scoring_request_id, failure_type, error_code, error_message, provider_response, attempts
  ) values (
    p_job_id, p_raw_post_id, p_scoring_request_id, p_failure_type, p_error_code, p_error_message, p_provider_response, p_attempts
  )
  on conflict (job_id) do update
    set failure_type = excluded.failure_type, error_code = excluded.error_code,
        error_message = excluded.error_message, provider_response = excluded.provider_response,
        attempts = excluded.attempts, dead_lettered_at = now();

  update public.scoring_job_state
     set status = 'dead_letter', last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;
  if p_msg_id is not null then perform pgmq.archive('scoring_jobs', p_msg_id); end if;
end
$$;

create or replace function public.record_scoring_failure(
  p_job_id uuid, p_msg_id bigint, p_raw_post_id uuid, p_scoring_request_id uuid,
  p_failure_type text, p_error_code text, p_error_message text, p_provider_response jsonb default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_job public.scoring_job_state%rowtype; v_fc int; v_backoff int;
begin
  select * into v_job from public.scoring_job_state where id = p_job_id for update;
  if not found then raise exception 'job % not found', p_job_id; end if;
  if v_job.raw_post_id <> p_raw_post_id then raise exception 'raw_post_id mismatch'; end if;
  if v_job.scoring_request_id <> p_scoring_request_id then raise exception 'scoring_request_id mismatch'; end if;
  if v_job.msg_id is distinct from p_msg_id then raise exception 'msg_id mismatch'; end if;
  if v_job.status not in ('pending','processing') then
    raise exception 'job % not in a failable state (status=%)', p_job_id, v_job.status;
  end if;

  v_fc := v_job.failure_count + 1;
  update public.scoring_job_state
     set failure_count = v_fc, last_failure_type = p_failure_type,
         last_error_code = p_error_code, last_error_message = p_error_message, updated_at = now()
   where id = p_job_id;

  if v_fc >= 3 then
    perform public.dead_letter_scoring_job(
      p_job_id, p_msg_id, p_raw_post_id, p_scoring_request_id,
      'exhausted', p_error_code, coalesce(p_error_message, p_failure_type), p_provider_response, v_fc);
    return 'dead_letter';
  end if;

  v_backoff := case v_fc when 1 then 30 when 2 then 120 else 120 end;   -- server-authoritative
  update public.scoring_job_state
     set next_attempt_at = now() + make_interval(secs => v_backoff), status = 'pending', updated_at = now()
   where id = p_job_id;
  if p_msg_id is not null then perform pgmq.set_vt('scoring_jobs', p_msg_id, v_backoff); end if;
  return 'retry';
end
$$;


-- =============================================================================
-- Promotion / rollback — copies the stored historical projection exactly
-- =============================================================================
create or replace function public.set_current_scoring_result(p_raw_post_id uuid, p_result_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_res public.scoring_results%rowtype; v_label_scores jsonb;
begin
  perform 1 from public.raw_posts where id = p_raw_post_id for update;

  select * into v_res from public.scoring_results where id = p_result_id;
  if not found then raise exception 'scoring_result % not found', p_result_id; end if;
  if v_res.raw_post_id <> p_raw_post_id then
    raise exception 'scoring_result % does not belong to raw_post %', p_result_id, p_raw_post_id;
  end if;
  if jsonb_typeof(v_res.config_snapshot -> 'themes') <> 'array'
     or jsonb_array_length(v_res.config_snapshot -> 'themes') = 0 then
    raise exception 'result % has a malformed snapshot theme list', p_result_id;
  end if;

  -- Project theme_id -> label using the RESULT's own snapshot, never the live table.
  select coalesce(jsonb_object_agg(t ->> 'label', (v_res.theme_scores ->> (t ->> 'theme_id'))), '{}'::jsonb)
    into v_label_scores
  from jsonb_array_elements(v_res.config_snapshot -> 'themes') t
  where v_res.theme_scores ? (t ->> 'theme_id');

  -- included_in_generation is the STORED historical value, not recomputed.
  insert into public.analyzed_posts (
    raw_post_id, relevance_scores, overall_relevance, reason_for_score,
    included_in_generation, current_result_id
  ) values (
    p_raw_post_id, v_label_scores, v_res.overall_relevance, v_res.reason,
    v_res.included_in_generation, p_result_id
  )
  on conflict (raw_post_id) do update
    set relevance_scores = excluded.relevance_scores, overall_relevance = excluded.overall_relevance,
        reason_for_score = excluded.reason_for_score, included_in_generation = excluded.included_in_generation,
        current_result_id = excluded.current_result_id, updated_at = now();
end
$$;


-- =============================================================================
-- Privileges — SELECT + controlled RPCs; no direct DML on the trusted tables
-- =============================================================================
alter table public.scoring_themes      enable row level security;
alter table public.scoring_requests    enable row level security;
alter table public.scoring_results     enable row level security;
alter table public.scoring_job_state   enable row level security;
alter table public.scoring_dead_letter enable row level security;

revoke all on public.scoring_themes      from anon, authenticated;
revoke all on public.scoring_requests    from anon, authenticated;
revoke all on public.scoring_results     from anon, authenticated;
revoke all on public.scoring_job_state   from anon, authenticated;
revoke all on public.scoring_dead_letter from anon, authenticated;

grant select on public.scoring_themes      to authenticated;
grant select on public.scoring_requests    to authenticated;
grant select on public.scoring_results     to authenticated;
grant select on public.scoring_job_state   to authenticated;
grant select on public.scoring_dead_letter to authenticated;

-- scoring_themes: admin may relabel/reorder/retire (theme_id guarded by trigger).
grant select, update on public.scoring_themes to service_role;
-- Everything else: SELECT only. All mutations go through the SECURITY DEFINER RPCs.
grant select on public.scoring_requests    to service_role;
grant select on public.scoring_results     to service_role;
grant select on public.scoring_job_state   to service_role;
grant select on public.scoring_dead_letter to service_role;

-- No role may TRUNCATE/TRIGGER/REFERENCES any scoring table. All state changes
-- go through the SECURITY DEFINER RPCs; nothing can bulk-wipe the queue state,
-- the request definitions, or the append-only history.
revoke truncate, trigger, references on
  public.scoring_themes, public.scoring_requests, public.scoring_results,
  public.scoring_job_state, public.scoring_dead_letter
  from service_role, authenticated, anon;

create policy scoring_themes_select_for_editors on public.scoring_themes
  for select to authenticated using ((select public.is_editor()));
create policy scoring_requests_select_for_editors on public.scoring_requests
  for select to authenticated using ((select public.is_editor()));
create policy scoring_results_select_for_editors on public.scoring_results
  for select to authenticated using ((select public.is_editor()));
create policy scoring_job_state_select_for_editors on public.scoring_job_state
  for select to authenticated using ((select public.is_editor()));
create policy scoring_dead_letter_select_for_editors on public.scoring_dead_letter
  for select to authenticated using ((select public.is_editor()));

grant usage on schema pgmq to service_role;
grant execute on all functions in schema pgmq to service_role;
grant select, insert, update, delete on all tables in schema pgmq to service_role;

-- RPC execute grants (service_role only).
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'create_scoring_request(text,text,text,jsonb,text,text,text)',
    'activate_scoring_request(uuid)',
    'close_scoring_request(uuid)',
    'enqueue_scoring_job(uuid,uuid)',
    'backfill_scoring_for_request(uuid)',
    'enqueue_reevaluation(uuid)',
    'open_production_scoring_request(text,text,jsonb,text,text,text)',
    'revive_scoring_job(uuid)',
    'import_legacy_analyses()',
    'complete_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb)',
    'dead_letter_scoring_job(uuid,bigint,uuid,uuid,text,text,text,jsonb,integer)',
    'record_scoring_failure(uuid,bigint,uuid,uuid,text,text,text,jsonb)',
    'set_current_scoring_result(uuid,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end
$grants$;


-- =============================================================================
-- Migration tail: queue + legacy history ONLY. No request, no jobs.
-- =============================================================================
select pgmq.create('scoring_jobs');
select public.import_legacy_analyses();

-- =============================================================================
-- 0024 — the editorial publication: one text per period, not one per cluster
-- =============================================================================
-- The original specification (CUES Technical Analysis TCA) asks for ONE
-- LinkedIn asset per publication cycle: a main post plus a carousel whose
-- slides are the themes. Clustering is an intermediate step there — the
-- skeleton of a single narrative, not a way of splitting the output.
--
-- What was built instead generates a post and a carousel PER CLUSTER, so a run
-- with 8 clusters produced 16 unrelated drafts and asked an editor to pick.
-- This migration adds the publication shape. The per-cluster path is NOT
-- removed: it stays callable, its rows stay readable, and the frontend simply
-- stops offering it (docs/SESSION_HANDOFF.md records why).
--
-- Design: a publication is another `cluster_generation_results` row, not a new
-- table. Review, Export (Markdown/JSON/Word), regenerate-with-feedback and the
-- append-only version history all key on `result_id` and none of them care
-- what a result is *about*. A separate table would have meant reimplementing
-- four mechanisms that already work in production; this way they carry over
-- untouched, including the after-insert trigger that seeds the review rows.
--
-- The cost of that choice, stated plainly: `cluster_id` stops being NOT NULL,
-- so the table now holds two shapes. The CHECK constraints below make the two
-- mutually exclusive and total, so neither can be written half-formed.
-- =============================================================================

-- --- requests -----------------------------------------------------------------
alter table public.cluster_generation_requests
  add column kind         text not null default 'per_cluster',
  add column period_start timestamptz,
  add column period_end   timestamptz;

alter table public.cluster_generation_requests
  add constraint cluster_generation_requests_kind_valid
    check (kind in ('per_cluster', 'publication'));

-- A publication covers a window the operator chose; a per-cluster draft does
-- not have one. Recording it is the point — "which days is this text about?"
-- is the first thing anyone asks of a periodical.
alter table public.cluster_generation_requests
  add constraint cluster_generation_requests_period_shape
    check (
      (kind = 'per_cluster' and period_start is null and period_end is null)
      or
      (kind = 'publication' and period_start is not null and period_end is not null
       and period_end > period_start)
    );

comment on column public.cluster_generation_requests.kind is
  'per_cluster — one post/carousel per selected cluster (the pre-0024 behaviour, still '
  'callable, no longer offered in the UI). publication — one post and one carousel '
  'synthesised across every selected cluster, which is what the CUES brief asks for.';

-- --- results ------------------------------------------------------------------
-- cluster_id loses NOT NULL: a publication belongs to many clusters, so it
-- names them in source_cluster_ids instead.
alter table public.cluster_generation_results
  alter column cluster_id drop not null;

alter table public.cluster_generation_results
  add column kind               text not null default 'per_cluster',
  add column source_cluster_ids uuid[],
  add column period_start       timestamptz,
  add column period_end         timestamptz;

alter table public.cluster_generation_results
  add constraint cluster_generation_results_kind_valid
    check (kind in ('per_cluster', 'publication'));

-- Exactly one shape per row, and each fully formed. Without this, a bug that
-- forgot to set kind would write a publication that looks like a cluster draft
-- with a missing cluster — readable, wrong, and hard to notice.
alter table public.cluster_generation_results
  add constraint cluster_generation_results_shape
    check (
      (kind = 'per_cluster'
        and cluster_id is not null
        and source_cluster_ids is null
        and period_start is null and period_end is null)
      or
      (kind = 'publication'
        and cluster_id is null
        and source_cluster_ids is not null and cardinality(source_cluster_ids) > 0
        and period_start is not null and period_end is not null)
    );

comment on column public.cluster_generation_results.kind is
  'per_cluster or publication. See cluster_generation_requests.kind.';
comment on column public.cluster_generation_results.source_cluster_ids is
  'For a publication: every cluster the text was synthesised from, in the order the '
  'carousel presents them. Null for a per-cluster draft, which uses cluster_id.';
comment on column public.cluster_generation_results.cluster_label is
  'For a per-cluster draft, the cluster''s own label. For a publication, the title of '
  'the publication itself — this column is what Review and Export show as the heading, '
  'and a publication needs one for exactly the same reason.';

create index cluster_generation_results_kind_idx
  on public.cluster_generation_results (kind, created_at desc);

-- =============================================================================
-- create_cluster_generation_request — now also opens publication requests
-- =============================================================================
-- Dropped rather than replaced, for the same reason 0023 recorded: parameters
-- with defaults create an OVERLOAD, not a replacement, and the existing
-- five-argument call would then be ambiguous ("function is not unique").
drop function if exists public.create_cluster_generation_request(uuid, uuid[], text[], text, uuid);

-- The new parameters are defaulted so every existing call site keeps working
-- and keeps meaning what it meant.
create function public.create_cluster_generation_request(
  p_clustering_run_id uuid,
  p_requested_cluster_ids uuid[],
  p_output_types text[],
  p_feedback text default null,
  p_regenerates_result_id uuid default null,
  p_kind text default 'per_cluster',
  p_period_start timestamptz default null,
  p_period_end timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare
  v_request_id uuid;
  v_run_status text;
  v_bad_cluster uuid;
  v_prev_kind text;
  v_prev_cluster_id uuid;
  v_prev_output_types text[];
begin
  if p_kind not in ('per_cluster', 'publication') then
    raise exception 'unknown generation kind %', p_kind;
  end if;

  select status into v_run_status from public.clustering_runs where id = p_clustering_run_id;
  if v_run_status is null then
    raise exception 'clustering_run % not found', p_clustering_run_id;
  end if;
  if v_run_status <> 'completed' then
    raise exception 'clustering_run % is not completed (status=%)', p_clustering_run_id, v_run_status;
  end if;

  if p_requested_cluster_ids is null or cardinality(p_requested_cluster_ids) = 0 then
    raise exception 'at least one cluster_id is required';
  end if;

  -- Every requested cluster must belong to THIS run — enforced here, at the
  -- database boundary, not trusted from the caller's own filtering.
  select rc.id into v_bad_cluster
  from unnest(p_requested_cluster_ids) as rc(id)
  left join public.clusters c on c.id = rc.id and c.clustering_run_id = p_clustering_run_id
  where c.id is null
  limit 1;
  if v_bad_cluster is not null then
    raise exception 'cluster % does not belong to clustering_run %', v_bad_cluster, p_clustering_run_id;
  end if;

  -- Regeneration invariants. A regeneration whose "previous draft" belongs to
  -- another cluster would put unrelated copy in the prompt and silently
  -- produce something nobody asked for.
  if p_regenerates_result_id is not null then
    select kind, cluster_id, output_types
      into v_prev_kind, v_prev_cluster_id, v_prev_output_types
      from public.cluster_generation_results where id = p_regenerates_result_id;
    if v_prev_kind is null then
      raise exception 'cluster_generation_result % not found', p_regenerates_result_id;
    end if;
    -- A revision answers a specific draft, so it must be the same shape: a
    -- publication cannot "revise" a single-cluster draft, or the editor's note
    -- would be applied to something they were not reading.
    if v_prev_kind <> p_kind then
      raise exception 'result % is a % draft, cannot regenerate it as a %',
        p_regenerates_result_id, v_prev_kind, p_kind;
    end if;
    if p_kind = 'per_cluster' then
      if cardinality(p_requested_cluster_ids) <> 1 then
        raise exception 'a regeneration covers exactly one cluster, got %',
          cardinality(p_requested_cluster_ids);
      end if;
      if p_requested_cluster_ids[1] <> v_prev_cluster_id then
        raise exception 'result % belongs to cluster %, not %',
          p_regenerates_result_id, v_prev_cluster_id, p_requested_cluster_ids[1];
      end if;
    end if;
    -- You cannot improve on a draft that was never produced.
    if not (p_output_types <@ v_prev_output_types) then
      raise exception 'result % has outputs %, cannot regenerate %',
        p_regenerates_result_id, v_prev_output_types, p_output_types;
    end if;
  end if;

  insert into public.cluster_generation_requests (
    clustering_run_id, requested_cluster_ids, output_types, status, created_by,
    feedback, regenerates_result_id, kind, period_start, period_end
  ) values (
    p_clustering_run_id, p_requested_cluster_ids, p_output_types, 'pending', (select auth.uid()),
    nullif(btrim(coalesce(p_feedback, '')), ''), p_regenerates_result_id,
    p_kind, p_period_start, p_period_end
  ) returning id into v_request_id;

  return v_request_id;
end
$fn$;

comment on function public.create_cluster_generation_request is
  'Opens a generation request. p_kind selects the shape: per_cluster produces one draft '
  'per selected cluster; publication produces a single post and carousel synthesised '
  'across all of them, over the period the operator chose. Validates run status, cluster '
  'membership and — for a revision — that the previous draft is the same shape.';

-- =============================================================================
-- complete_editorial_publication — persists the single synthesised text
-- =============================================================================
-- Deliberately a separate function rather than more optional parameters on
-- complete_cluster_generation_result: the two write different column sets and
-- validate different things, and one function doing both by branching on a
-- flag is where a wrong-shaped row eventually gets written.
create or replace function public.complete_editorial_publication(
  p_request_id uuid,
  p_title text,
  p_source_cluster_ids uuid[],
  p_raw_post_ids uuid[],
  p_anonymize_result_ids uuid[],
  p_output_types text[],
  p_post_output jsonb,
  p_carousel_output jsonb,
  p_config_snapshot jsonb,
  p_prompt_version text,
  p_prompt_hash text,
  p_model text,
  p_provider_response jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.cluster_generation_requests%rowtype;
  v_bad_cluster uuid;
  v_result_id uuid;
begin
  select * into v_request from public.cluster_generation_requests
    where id = p_request_id for update;
  if not found then raise exception 'cluster_generation_request % not found', p_request_id; end if;
  if v_request.status <> 'pending' then
    raise exception 'cluster_generation_request % is not pending (status=%)',
      p_request_id, v_request.status;
  end if;
  if v_request.kind <> 'publication' then
    raise exception 'cluster_generation_request % is a % request', p_request_id, v_request.kind;
  end if;

  if p_source_cluster_ids is null or cardinality(p_source_cluster_ids) = 0 then
    raise exception 'a publication must name the clusters it was built from';
  end if;

  -- Same principle as the per-cluster path: re-derive membership from
  -- public.clusters rather than trusting the caller's scoping.
  select sc.id into v_bad_cluster
  from unnest(p_source_cluster_ids) as sc(id)
  left join public.clusters c
    on c.id = sc.id and c.clustering_run_id = v_request.clustering_run_id
  where c.id is null
  limit 1;
  if v_bad_cluster is not null then
    raise exception 'cluster % does not belong to clustering_run %',
      v_bad_cluster, v_request.clustering_run_id;
  end if;

  insert into public.cluster_generation_results (
    generation_request_id, clustering_run_id, kind,
    cluster_id, cluster_label, source_cluster_ids,
    period_start, period_end,
    raw_post_ids, anonymize_result_ids, output_types,
    post_output, carousel_output,
    config_snapshot, prompt_version, prompt_hash, model, provider_response
  ) values (
    p_request_id, v_request.clustering_run_id, 'publication',
    null, p_title, p_source_cluster_ids,
    v_request.period_start, v_request.period_end,
    p_raw_post_ids, p_anonymize_result_ids, p_output_types,
    p_post_output, p_carousel_output,
    p_config_snapshot, p_prompt_version, p_prompt_hash, p_model, p_provider_response
  ) returning id into v_result_id;

  return v_result_id;
end
$$;

comment on function public.complete_editorial_publication is
  'Persists the one synthesised editorial text for a publication request. The period is '
  'copied from the request, not taken from the caller, so the text can never claim to '
  'cover a window nobody asked for. Seeds review rows through the same after-insert '
  'trigger as a per-cluster result.';

-- =============================================================================
-- Failure and completion accounting for a one-result request
-- =============================================================================
-- Both of these were written on the assumption that a request produces exactly
-- one outcome PER CLUSTER. A publication produces one outcome for all of them,
-- so without this it would raise on the way out — after the LLM had been paid
-- for and the text persisted.

-- A publication failure belongs to no single cluster.
alter table public.cluster_generation_request_errors
  alter column cluster_id drop not null;

comment on column public.cluster_generation_request_errors.cluster_id is
  'The cluster that failed, for a per_cluster request. Null for a publication failure, '
  'which belongs to the request as a whole rather than to any one cluster.';

create or replace function public.record_publication_error(
  p_request_id uuid,
  p_error_type text,
  p_error_message text
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_kind text;
begin
  select kind into v_kind from public.cluster_generation_requests where id = p_request_id;
  if v_kind is null then raise exception 'cluster_generation_request % not found', p_request_id; end if;
  if v_kind <> 'publication' then
    raise exception 'cluster_generation_request % is a % request', p_request_id, v_kind;
  end if;

  insert into public.cluster_generation_request_errors
    (generation_request_id, cluster_id, error_type, error_message)
  values (p_request_id, null, p_error_type, p_error_message);
end
$$;

comment on function public.record_publication_error is
  'Records the failure of a publication request, which has no cluster to blame.';

-- finish_cluster_generation_request — now counts by request kind.
create or replace function public.finish_cluster_generation_request(
  p_request_id uuid
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.cluster_generation_requests%rowtype;
  v_result_count integer;
  v_error_count integer;
  v_expected integer;
  v_final_status text;
begin
  select * into v_request from public.cluster_generation_requests where id = p_request_id for update;
  if not found then raise exception 'cluster_generation_request % not found', p_request_id; end if;
  if v_request.status <> 'pending' then
    raise exception 'cluster_generation_request % is not pending (status=%)', p_request_id, v_request.status;
  end if;

  select count(*) into v_result_count from public.cluster_generation_results where generation_request_id = p_request_id;
  select count(*) into v_error_count from public.cluster_generation_request_errors where generation_request_id = p_request_id;

  -- A per_cluster request owes one outcome per cluster; a publication owes
  -- exactly one, however many clusters it drew on.
  v_expected := case v_request.kind
    when 'publication' then 1
    else cardinality(v_request.requested_cluster_ids)
  end;

  if v_result_count + v_error_count <> v_expected then
    raise exception
      'cluster_generation_request %: % result(s) + % error(s) does not match % expected outcome(s)',
      p_request_id, v_result_count, v_error_count, v_expected;
  end if;

  v_final_status := case when v_error_count = 0 then 'completed' else 'failed' end;

  update public.cluster_generation_requests
     set status = v_final_status,
         error_message = case
           when v_error_count = 0 then null
           when v_request.kind = 'publication' then 'the publication failed to generate'
           else format('%s of %s requested cluster(s) failed to generate',
                       v_error_count, cardinality(v_request.requested_cluster_ids))
           end,
         completed_at = now()
   where id = p_request_id;

  return v_final_status;
end
$$;

comment on function public.finish_cluster_generation_request is
  'Closes a generation request as completed or failed. Expects one outcome per cluster for '
  'a per_cluster request and exactly one for a publication — the count is what stops a '
  'request being closed while work is still outstanding.';

-- =============================================================================
-- Grants — service_role only, like the other generation lifecycle RPCs
-- =============================================================================
revoke all on function public.record_publication_error(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_publication_error(uuid, text, text) to service_role;

revoke all on function public.complete_editorial_publication(
  uuid, text, uuid[], uuid[], uuid[], text[], jsonb, jsonb, jsonb, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_editorial_publication(
  uuid, text, uuid[], uuid[], uuid[], text[], jsonb, jsonb, jsonb, text, text, text, jsonb
) to service_role;

revoke all on function public.create_cluster_generation_request(
  uuid, uuid[], text[], text, uuid, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.create_cluster_generation_request(
  uuid, uuid[], text[], text, uuid, text, timestamptz, timestamptz
) to service_role;

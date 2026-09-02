-- =============================================================================
-- 0023_generation_feedback.sql — regenerate a draft with an editor's note
-- =============================================================================
--
-- An editor reads generated copy in Review, does not like it, and today has
-- exactly two options: rewrite it by hand, or go back to Clusters and press
-- Generate again — which sends the identical prompt and produces roughly the
-- identical draft. "Too corporate, lead with the policy angle" has nowhere to
-- go.
--
-- This adds the third option. It is deliberately NOT an edit of anything that
-- exists: cluster_generation_results is append-only (0016's _no_update /
-- _no_delete triggers), and its own comment already states the rule — "a later
-- re-generation is simply a new request producing new rows, never an overwrite
-- of this one". So a regeneration is an ordinary generation request that
-- happens to carry two extra facts: which result it is trying to improve on,
-- and what the editor asked for.
--
-- Storing the note rather than passing it through: prompt_hash already changes
-- when the feedback changes, so two results are distinguishable — but only the
-- stored note answers "what did we ask for, and did we get it". That is the
-- same provenance discipline as config_snapshot and prompt_version on every
-- result row.
--
-- What this migration does NOT do: revoke an approval. See
-- supersede_generation_review below.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The request records what it was asked to improve, and how
-- -----------------------------------------------------------------------------
alter table public.cluster_generation_requests
  add column feedback              text,
  add column regenerates_result_id uuid references public.cluster_generation_results (id) on delete restrict;

-- A bound, not a validation. The note is pasted straight into a prompt, and an
-- unbounded field there is a way to spend the model's whole context on one
-- request by accident.
alter table public.cluster_generation_requests
  add constraint cluster_generation_requests_feedback_bounded
    check (feedback is null or char_length(feedback) <= 2000);

comment on column public.cluster_generation_requests.feedback is
  'The editor''s instruction for this generation, pasted into the prompt. Null on an ordinary '
  'first-pass generation.';

comment on column public.cluster_generation_requests.regenerates_result_id is
  'The result this request is trying to improve on. Non-null marks the request a regeneration: '
  'exactly one cluster, and the previous draft is included in the prompt so the feedback has '
  'something to refer to. Null on a first-pass generation.';

create index cluster_generation_requests_regenerates_idx
  on public.cluster_generation_requests (regenerates_result_id)
  where regenerates_result_id is not null;


-- -----------------------------------------------------------------------------
-- create_cluster_generation_request — now also validates a regeneration
-- -----------------------------------------------------------------------------
-- Dropped rather than replaced: adding parameters with defaults would create an
-- OVERLOAD, and the existing three-argument call would then be ambiguous.
-- -----------------------------------------------------------------------------
drop function if exists public.create_cluster_generation_request(uuid, uuid[], text[]);

create function public.create_cluster_generation_request(
  p_clustering_run_id uuid,
  p_requested_cluster_ids uuid[],
  p_output_types text[],
  p_feedback text default null,
  p_regenerates_result_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare
  v_request_id uuid;
  v_run_status text;
  v_bad_cluster uuid;
  v_prev_cluster_id uuid;
  v_prev_output_types text[];
begin
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
    select cluster_id, output_types into v_prev_cluster_id, v_prev_output_types
      from public.cluster_generation_results where id = p_regenerates_result_id;
    if v_prev_cluster_id is null then
      raise exception 'cluster_generation_result % not found', p_regenerates_result_id;
    end if;
    if cardinality(p_requested_cluster_ids) <> 1 then
      raise exception 'a regeneration covers exactly one cluster, got %',
        cardinality(p_requested_cluster_ids);
    end if;
    if p_requested_cluster_ids[1] <> v_prev_cluster_id then
      raise exception 'result % belongs to cluster %, not %',
        p_regenerates_result_id, v_prev_cluster_id, p_requested_cluster_ids[1];
    end if;
    -- You cannot improve on a draft that was never produced.
    if not (p_output_types <@ v_prev_output_types) then
      raise exception 'result % has outputs %, cannot regenerate %',
        p_regenerates_result_id, v_prev_output_types, p_output_types;
    end if;
  end if;

  insert into public.cluster_generation_requests (
    clustering_run_id, requested_cluster_ids, output_types, status, created_by,
    feedback, regenerates_result_id
  ) values (
    p_clustering_run_id, p_requested_cluster_ids, p_output_types, 'pending', (select auth.uid()),
    nullif(btrim(coalesce(p_feedback, '')), ''), p_regenerates_result_id
  ) returning id into v_request_id;

  return v_request_id;
end
$fn$;

comment on function public.create_cluster_generation_request is
  'Phase 1 of 2. Validates the run is completed and every requested cluster_id belongs to it, '
  'then inserts a pending request row before any LLM call happens. When p_regenerates_result_id '
  'is given the request is a regeneration: exactly one cluster, matching the previous result''s '
  'own cluster, and only for outputs that result actually carries.';


-- -----------------------------------------------------------------------------
-- The review row learns that a newer draft exists
-- -----------------------------------------------------------------------------
alter table public.cluster_generation_reviews
  drop constraint cluster_generation_reviews_status_check;

alter table public.cluster_generation_reviews
  add constraint cluster_generation_reviews_status_check
    check (status in ('draft', 'approved', 'rejected', 'published', 'superseded'));

alter table public.cluster_generation_reviews
  add column superseded_by_result_id uuid references public.cluster_generation_results (id) on delete restrict;

comment on column public.cluster_generation_reviews.superseded_by_result_id is
  'The result produced by a regeneration of this one. Set independently of status: an approved '
  'row keeps its approval and merely gains a pointer to the newer draft.';


-- -----------------------------------------------------------------------------
-- supersede_generation_review — link the old draft to its replacement
-- -----------------------------------------------------------------------------
-- Called by `generate` once a regeneration result lands, so an editor's
-- Generated list does not fill with drafts that have already been answered.
--
-- Status moves to 'superseded' ONLY from 'draft' or 'rejected'. An approved or
-- published row keeps its status and gains the pointer alone. Approval is a
-- human decision about one specific piece of copy; a background step that
-- silently un-approved it would mean copy disappearing from Export because
-- somebody pressed Regenerate to explore a variant. An editor who does mean to
-- withdraw the old version can still reject it by hand.
-- -----------------------------------------------------------------------------
create or replace function public.supersede_generation_review(
  p_old_result_id uuid,
  p_output_type text,
  p_new_result_id uuid
) returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  v_old_cluster uuid;
  v_new_cluster uuid;
  v_new_outputs text[];
  v_status text;
  v_next text;
begin
  select cluster_id into v_old_cluster
    from public.cluster_generation_results where id = p_old_result_id;
  if v_old_cluster is null then
    raise exception 'cluster_generation_result % not found', p_old_result_id;
  end if;

  select cluster_id, output_types into v_new_cluster, v_new_outputs
    from public.cluster_generation_results where id = p_new_result_id;
  if v_new_cluster is null then
    raise exception 'cluster_generation_result % not found', p_new_result_id;
  end if;

  -- Two drafts of different clusters are not versions of each other.
  if v_old_cluster <> v_new_cluster then
    raise exception 'results % and % are for different clusters', p_old_result_id, p_new_result_id;
  end if;
  if not (p_output_type = any(v_new_outputs)) then
    raise exception 'result % has no % output', p_new_result_id, p_output_type;
  end if;

  select status into v_status from public.cluster_generation_reviews
    where result_id = p_old_result_id and output_type = p_output_type
    for update;
  if v_status is null then
    raise exception 'no review row for result % / %', p_old_result_id, p_output_type;
  end if;

  v_next := case when v_status in ('draft', 'rejected') then 'superseded' else v_status end;

  update public.cluster_generation_reviews
     set superseded_by_result_id = p_new_result_id,
         status = v_next
   where result_id = p_old_result_id and output_type = p_output_type;

  return v_next;
end
$fn$;

comment on function public.supersede_generation_review is
  'Points one review row at the regeneration that replaced it. Moves status to ''superseded'' '
  'only from ''draft'' or ''rejected'' — an approval is a decision about specific copy and is '
  'never revoked by a background step.';


-- =============================================================================
-- Grants — service_role only, exactly like 0016's other generation RPCs
-- =============================================================================
-- These are pipeline steps, not operator actions. An editor triggers a
-- regeneration by calling the `generate` function, which authenticates them and
-- then does this work under the service role; nothing an editor holds can
-- create a request row or move a review to 'superseded' directly. Note that
-- create_cluster_generation_request was DROPPED above, which discards the
-- grants 0016 gave the three-argument signature.
-- =============================================================================
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'create_cluster_generation_request(uuid,uuid[],text[],text,uuid)',
    'supersede_generation_review(uuid,text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end
$grants$;

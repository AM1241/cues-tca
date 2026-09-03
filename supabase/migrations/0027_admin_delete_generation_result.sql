-- =============================================================================
-- 0027 — an admin can permanently delete a generated result, approved or not
-- =============================================================================
-- 0016 made cluster_generation_results append-only for every caller, no
-- exception: "a re-generation is a new request producing new rows" is the
-- whole reason regenerate-with-feedback (0023) and the publication shape
-- (0024) could both be built without ever worrying about losing history.
-- Session 16 built on the same premise: "an approval is never revoked" — but
-- that governs what the SYSTEM does automatically (regeneration, re-scoring),
-- not a deliberate admin action. The operator asked for the latter directly,
-- specifically so a source's block in purge_source (0026) — cited in
-- generated copy, some of it approved — can be lifted on purpose rather than
-- being permanent by construction.
--
-- This does not weaken the append-only guarantee for anyone else. The trigger
-- still blocks every UPDATE unconditionally, and blocks DELETE unless a
-- transaction-local flag is set — a flag nothing reachable from PostgREST can
-- set, because only admin_delete_generation_result() ever calls set_config for
-- it, immediately before the one DELETE it performs, scoped to that
-- transaction alone.
-- =============================================================================

create or replace function public.cluster_generation_results_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('cues.allow_result_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'cluster_generation_results is append-only (% blocked)', tg_op;
end
$$;
-- Triggers reference the function by name and need no change.

create or replace function public.admin_delete_generation_result(p_result_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_label text;
  v_kind text;
  v_output_types text[];
  v_was_approved boolean;
  n_reviews int;
  n_regen_refs int;
  n_superseded_refs int;
begin
  if not (select public.is_admin()) then
    raise exception 'only an admin may delete generated copy';
  end if;

  select cluster_label, kind, output_types into v_label, v_kind, v_output_types
    from public.cluster_generation_results where id = p_result_id;
  if v_label is null then
    raise exception 'cluster_generation_result % not found', p_result_id;
  end if;

  select exists(
    select 1 from public.cluster_generation_reviews
     where result_id = p_result_id and status = 'approved'
  ) into v_was_approved;

  -- Pointers FROM elsewhere TO this result are cleared, not treated as a
  -- block: refusing over them would make this useless for exactly the case
  -- it exists for — an old, approved draft nobody can otherwise act on.
  -- Losing "this was a regeneration of X" / "X was superseded by this" is an
  -- acceptable loss of provenance; the newer rows themselves are untouched.
  update public.cluster_generation_requests
     set regenerates_result_id = null
   where regenerates_result_id = p_result_id;
  get diagnostics n_regen_refs = row_count;

  update public.cluster_generation_reviews
     set superseded_by_result_id = null
   where superseded_by_result_id = p_result_id;
  get diagnostics n_superseded_refs = row_count;

  -- This result's OWN reviews are a RESTRICT child and must go first.
  delete from public.cluster_generation_reviews where result_id = p_result_id;
  get diagnostics n_reviews = row_count;

  -- Lifts the append-only guard for exactly this delete, exactly this
  -- transaction — is_local=true means it cannot outlive commit or rollback.
  perform set_config('cues.allow_result_delete', 'on', true);
  delete from public.cluster_generation_results where id = p_result_id;

  return jsonb_build_object(
    'result_id', p_result_id,
    'cluster_label', v_label,
    'kind', v_kind,
    'output_types', v_output_types,
    'was_approved', v_was_approved,
    'reviews_removed', n_reviews,
    'regeneration_links_cleared', n_regen_refs,
    'superseded_links_cleared', n_superseded_refs
  );
end;
$fn$;

comment on function public.admin_delete_generation_result(uuid) is
  'Admin-only permanent deletion of one generated result (its post/carousel output and its '
  'review rows), including an APPROVED one, on deliberate operator instruction — distinct from '
  'the system''s own "an approval is never revoked" rule for regeneration. Lifts '
  'cluster_generation_results append-only guard for exactly this delete via a transaction-local '
  'flag nothing else can set.';

revoke all on function public.admin_delete_generation_result(uuid) from public, anon;
grant execute on function public.admin_delete_generation_result(uuid) to authenticated, service_role;

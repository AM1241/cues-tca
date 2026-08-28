-- =============================================================================
-- 0019_editorial_domain.sql — make the pipeline domain-neutral
-- =============================================================================
--
-- The tool was hardcoded to food in four places no operator could reach: the
-- scoring rubric ("strong relevance to food, agriculture, ..."), both
-- anonymiser generics ("a food-sector organization" / "another food-sector
-- organization"), and the generator's default brief. Pointed at another sector
-- it would have scored against a food rubric and renamed that sector's
-- companies to "a food-sector organization".
--
-- It also let off-domain posts in. Themes are ANGLES, not SCOPE:
-- "sustainability" applies to food, textiles and energy alike, and a theme list
-- cannot express "sustainability, in food". Measured on the 8 real scorings:
-- a textile-waste post scored 92 on sustainability and an energy-policy post 75
-- — both admitted, and neither fixable by any theme configuration, because
-- sustainability and innovation are themes the operator obviously keeps.
-- Removing "talent development" fixes only the three talent-driven cases.
--
-- The fix is one operator-owned statement of scope, feeding scoring,
-- anonymisation and generation alike. Out-of-domain is expressed in the RUBRIC
-- rather than as a separate score, so nothing about the append-only result
-- schema or the completion RPC signatures has to change: an off-domain post
-- simply scores 0 on every theme, and its reason says why.
--
-- ---------------------------------------------------------------------------
-- THE CUES PRESET — restoring the pre-0019 direction is this one statement:
--
--   update public.configurations set
--     editorial_domain          = 'food, agriculture and the agrifood supply chain',
--     domain_generic_entity     = 'a food-sector organization',
--     domain_generic_entity_alt = 'another food-sector organization'
--   where id = 'default';
--
-- These are also the column defaults below, so day-one behaviour is unchanged.
-- Kept in docs/presets.md too.
-- ---------------------------------------------------------------------------
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Scope, stated once, by the operator
-- -----------------------------------------------------------------------------
alter table public.configurations
  add column editorial_domain text not null
    default 'food, agriculture and the agrifood supply chain',
  add column domain_generic_entity text not null
    default 'a food-sector organization',
  add column domain_generic_entity_alt text not null
    default 'another food-sector organization';

comment on column public.configurations.editorial_domain is
  'What this publication is about. Rendered into the scoring rubric as {{DOMAIN}} and into the '
  'generator brief. A post outside it scores 0 on every theme, however strongly it matches a '
  'theme in the abstract — themes are angles within this scope, not scope themselves.';

comment on column public.configurations.domain_generic_entity is
  'What the anonymiser replaces a company name with ("a food-sector organization"). Sector-'
  'specific, so it belongs with the domain rather than hardcoded in anonymize-worker.';

comment on column public.configurations.domain_generic_entity_alt is
  'The second-mention variant ("another food-sector organization"), used when a post already '
  'refers to one generic organisation.';


-- -----------------------------------------------------------------------------
-- The rubric becomes domain-scoped
-- -----------------------------------------------------------------------------
-- Same signature, so every caller and dependency is untouched. Requests already
-- store their own prompt_template immutably, so historical results keep the
-- rubric they were actually scored under — this only affects requests created
-- from here on.
-- -----------------------------------------------------------------------------
create or replace function public.scoring_prompt_template()
returns text language sql immutable as $fn$
  select $tmpl$You are scoring LinkedIn posts for an editorial pipeline covering {{DOMAIN}}.

Score how relevant this post is to each editorial theme below, as it applies within {{DOMAIN}}.

Themes:
{{THEMES}}

Scope rule — apply this BEFORE the rubric:
A post that is not about {{DOMAIN}} scores 0 on EVERY theme, however strongly it
matches a theme in the abstract. A post about sustainability, innovation or
talent in an unrelated sector is not a relevant post for this pipeline.

Scoring rubric (apply per theme, to posts inside {{DOMAIN}}):
0-20 = unrelated noise or pure marketing
21-40 = weak or indirect relevance
41-60 = partial relevance with some editorial value
61-80 = strong relevance to the theme
81-100 = direct high-value relevance with clear editorial usefulness

Rules:
- Score every theme independently as an integer from 0 to 100.
- Include every listed theme_id in theme_scores, using the exact theme_id given.
- Be conservative and context-aware; do not inflate scores for marketing language.
- reason is a short explanation (1-2 sentences) of the overall editorial relevance.
  If the post falls outside {{DOMAIN}}, say so explicitly.

Source: {{SOURCE}}
Post ID: {{POST_ID}}

POST TEXT:
{{POST_TEXT}}$tmpl$
$fn$;

-- Separable provenance: results scored under the domain-scoped rubric are
-- distinguishable from scoring_v1 ones without inspecting the template text.
create or replace function public.scoring_prompt_version()
returns text language sql immutable as $$ select 'scoring_v2'::text $$;

-- The domain is pinned per request, exactly as themes and threshold already are,
-- so a historical result can always answer "which scope was this scored under".
create or replace function public.scoring_config_snapshot()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'themes', public.scoring_theme_snapshot(),
    'min_relevance_score', (select min_relevance_score from public.configurations where id = 'default'),
    'editorial_domain', (select editorial_domain from public.configurations where id = 'default'),
    'prompt_version', public.scoring_prompt_version()
  )
$$;


-- -----------------------------------------------------------------------------
-- One theme list, editable from the UI
-- -----------------------------------------------------------------------------
-- There were two: scoring_themes drove the scorer, configurations.themes was
-- what the Objective screen edited and only ever reached the generator. Nothing
-- synced them, so removing a theme in the UI did not change scoring at all.
--
-- scoring_themes stays the source of truth: its theme_ids are trigger-guarded
-- immutable and referenced by every stored result's theme_scores, and `active`
-- expresses retire-don't-delete. A plain text array can carry neither.
-- configurations.themes becomes a derived mirror, written only by this RPC, so
-- anything still reading it stays consistent instead of silently drifting.
--
-- Editor-callable rather than service-role-only: editing the editorial
-- objective is an operator action, and configurations already grants editors a
-- direct UPDATE. Going through a SECURITY DEFINER RPC is the stricter form of
-- that — it can enforce invariants (retire rather than delete, at least one
-- active theme) that a column grant cannot.
-- -----------------------------------------------------------------------------
create or replace function public.set_scoring_themes(p_themes jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  -- Reachable only by `authenticated` and `service_role` (see the grants
  -- below). service_role is the trusted internal caller and carries no
  -- auth.uid(), so it is admitted on its role claim; anyone arriving with a
  -- user JWT must be on the editors allowlist.
  if coalesce((select auth.role()), '') <> 'service_role'
     and not (select public.is_editor()) then
    raise exception 'not authorised';
  end if;

  if p_themes is null or jsonb_typeof(p_themes) <> 'array' or jsonb_array_length(p_themes) = 0 then
    raise exception 'themes must be a non-empty array';
  end if;

  -- Validate before touching anything: a half-applied theme list would be
  -- scored against on the next request.
  if exists (
    select 1 from jsonb_array_elements(p_themes) t
    where coalesce(t ->> 'theme_id', '') = '' or coalesce(t ->> 'label', '') = ''
  ) then
    raise exception 'every theme needs a non-empty theme_id and label';
  end if;

  select count(distinct t ->> 'theme_id') into v_count from jsonb_array_elements(p_themes) t;
  if v_count <> jsonb_array_length(p_themes) then
    raise exception 'duplicate theme_id in themes';
  end if;

  select count(distinct t ->> 'label') into v_count from jsonb_array_elements(p_themes) t;
  if v_count <> jsonb_array_length(p_themes) then
    raise exception 'duplicate label in themes';
  end if;

  -- position and label are UNIQUE, so a reorder collides mid-update unless the
  -- existing rows are first moved out of the way. Negative positions are never
  -- valid input, so they cannot collide with the incoming set.
  update public.scoring_themes set position = -position where position > 0;

  insert into public.scoring_themes (theme_id, label, position, active)
  select t ->> 'theme_id',
         t ->> 'label',
         (t ->> 'position')::integer,
         coalesce((t ->> 'active')::boolean, true)
  from jsonb_array_elements(p_themes) t
  on conflict (theme_id) do update
    set label = excluded.label, position = excluded.position, active = excluded.active;

  -- Themes the operator dropped are retired, never deleted: stored results
  -- reference their theme_ids, and validate_theme_scores reads the snapshot the
  -- result was scored under, not the live list.
  --
  -- They are parked AFTER the highest live position rather than simply negated
  -- back: position is UNIQUE, so restoring a retired theme's original number
  -- collides with whichever incoming theme now occupies it.
  update public.scoring_themes s
     set active = false,
         position = r.parked_position
    from (
      select theme_id,
             (select coalesce(max(position), 0) from public.scoring_themes where position > 0)
               + row_number() over (order by position desc) as parked_position
      from public.scoring_themes
      where position < 0
    ) r
   where s.theme_id = r.theme_id;

  if not exists (select 1 from public.scoring_themes where active) then
    raise exception 'at least one theme must stay active';
  end if;

  -- Keep the derived mirror consistent for anything still reading it.
  update public.configurations
     set themes = (
       select coalesce(jsonb_agg(to_jsonb(label) order by position), '[]'::jsonb)
       from public.scoring_themes where active
     ),
     updated_at = now()
   where id = 'default';
end
$$;

comment on function public.set_scoring_themes is
  'Replaces the editable theme list from the Objective screen. Themes absent from the payload '
  'are retired (active = false), never deleted, because stored results reference their '
  'theme_ids. Also refreshes configurations.themes, which is a derived mirror rather than an '
  'independent list — before 0019 the two could disagree and UI theme edits never reached '
  'the scorer.';

revoke all on function public.set_scoring_themes(jsonb) from public, anon;
grant execute on function public.set_scoring_themes(jsonb) to authenticated, service_role;

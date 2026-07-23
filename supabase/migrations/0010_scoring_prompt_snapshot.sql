-- =============================================================================
-- 0010_scoring_prompt_snapshot.sql — Phase 3C blocker #3
-- =============================================================================
-- Immutable prompt snapshot on the scoring_request.
--
-- Until now the request captured prompt_version ('scoring_v1') and a
-- prompt_hash, but not the prompt TEXT — that lived only as a hardcoded constant
-- in score-worker/prompt.ts. A later edit to that constant would be
-- indistinguishable from the prompt a historical result was actually scored
-- with. This makes the template a database row (consistent with "config is a
-- database row"): the request stores the exact template, the worker renders the
-- prompt from that stored template, and prompt_hash = md5(template) so the hash
-- can never drift from the text.
-- =============================================================================

-- 1. Column ------------------------------------------------------------------
alter table public.scoring_requests add column prompt_template text;

-- 2. Canonical template (single source of truth) -----------------------------
-- Placeholders {{THEMES}}, {{SOURCE}}, {{POST_ID}}, {{POST_TEXT}} are
-- interpolated by the worker. This is the exact per-theme rubric prompt the
-- worker previously hardcoded — ported verbatim so scoring behaviour is
-- unchanged.
create or replace function public.scoring_prompt_template()
returns text language sql immutable as $$
select $tmpl$You are scoring LinkedIn posts for the CUES editorial pipeline.

Score how relevant this post is to each editorial theme below.

Themes:
{{THEMES}}

Scoring rubric (apply per theme):
0-20 = unrelated noise or pure marketing
21-40 = weak or indirect relevance
41-60 = partial relevance with some editorial value
61-80 = strong relevance to food, agriculture, sustainability, supply chain, innovation, or talent
81-100 = direct high-value relevance with clear editorial usefulness

Rules:
- Score every theme independently as an integer from 0 to 100.
- Include every listed theme_id in theme_scores, using the exact theme_id given.
- Be conservative and context-aware; do not inflate scores for marketing language.
- reason is a short explanation (1-2 sentences) of the overall editorial relevance.

Source: {{SOURCE}}
Post ID: {{POST_ID}}

POST TEXT:
{{POST_TEXT}}$tmpl$
$$;

-- 3. create_scoring_request stores the template and derives the hash ----------
-- Param count changes (adds p_prompt_template), so drop the old signature.
-- p_prompt_hash is retained for signature stability but ignored: the stored
-- hash is always md5 of the stored template, so the two can never disagree.
drop function if exists public.create_scoring_request(text, text, text, jsonb, text, text, text);
create or replace function public.create_scoring_request(
  p_purpose text, p_prompt_version text, p_prompt_hash text, p_config_snapshot jsonb,
  p_model text, p_model_snapshot text, p_aggregation_strategy text,
  p_prompt_template text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_template text;
begin
  if jsonb_typeof(p_config_snapshot -> 'themes') <> 'array'
     or jsonb_array_length(p_config_snapshot -> 'themes') = 0
     or (p_config_snapshot ->> 'min_relevance_score') is null then
    raise exception 'config_snapshot must contain themes and min_relevance_score';
  end if;
  v_template := coalesce(p_prompt_template, public.scoring_prompt_template());
  insert into public.scoring_requests (
    purpose, prompt_version, prompt_hash, prompt_template, config_snapshot, config_hash,
    model, model_snapshot, aggregation_strategy, status
  ) values (
    p_purpose, p_prompt_version, md5(v_template), v_template, p_config_snapshot,
    public.scoring_hash_of_snapshot(p_config_snapshot),
    p_model, p_model_snapshot, p_aggregation_strategy, 'draft'
  ) returning id into v_id;
  return v_id;
end
$$;
revoke all on function public.create_scoring_request(text,text,text,jsonb,text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_scoring_request(text,text,text,jsonb,text,text,text,text) to service_role;

-- 4. Backfill existing (test/eval) requests, then enforce NOT NULL ------------
-- MUST run before the guard below starts protecting prompt_template, otherwise
-- this null -> template UPDATE would trip the immutability check on any DB that
-- already has scoring_requests rows (the cloud does; a fresh db reset does not,
-- which is why ordering was invisible locally).
update public.scoring_requests set prompt_template = public.scoring_prompt_template()
 where prompt_template is null;
alter table public.scoring_requests alter column prompt_template set not null;

-- 5. Extend the immutability guard so the template cannot change on update -----
create or replace function public.scoring_requests_guard()
returns trigger language plpgsql as $$
begin
  if new.id <> old.id or new.purpose <> old.purpose or new.prompt_version <> old.prompt_version
     or new.prompt_hash <> old.prompt_hash or new.config_snapshot <> old.config_snapshot
     or new.config_hash <> old.config_hash or new.model <> old.model
     or new.model_snapshot <> old.model_snapshot or new.aggregation_strategy <> old.aggregation_strategy
     or new.prompt_template is distinct from old.prompt_template then
    raise exception 'scoring_requests definition is immutable; only status may change';
  end if;
  return new;
end
$$;

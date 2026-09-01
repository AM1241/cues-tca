-- =============================================================================
-- 0021_operator_queue_controls.sql — let an editor fill the queues they drain
-- =============================================================================
--
-- Two buttons in the product consume work: "Score now" drains the scoring queue,
-- "Anonymise now" drains the anonymise queue. Nothing anywhere in the UI can put
-- work INTO either of them.
--
-- The functions that can — backfill_scoring_for_request, enqueue_reevaluation,
-- open_production_scoring_request, backfill_anonymize_jobs — are all
-- service_role only and unreachable from a browser. Every scoring and
-- re-anonymisation run on 2026-08-31 and 2026-09-01 was therefore started by
-- hand in SQL. That directly contradicts the plan's stated goal ("an editor
-- opens a URL … no terminal"), and it is why "Score now" answered "the queue is
-- empty" for a month while 47 posts sat unscored.
--
-- These two RPCs are the missing half. They are deliberately thin wrappers: the
-- lifecycle rules stay in the functions that already own them.
--
-- One thing they add beyond wrapping, and it matters: a scoring_request pins an
-- immutable config snapshot at creation. Change the domain or the themes in the
-- Objective screen while a request is active, and scoring carries on with the
-- OLD snapshot — the operator's edit silently does nothing. queue_scoring
-- compares hashes and rotates the request when they differ, so a configuration
-- change actually reaches the scorer.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- The scoring model, where the rest of the objective already lives
-- -----------------------------------------------------------------------------
-- queue_scoring has to open a scoring_request, and a request needs a model. The
-- first draft read it from "the most recent request", which fails outright on a
-- fresh database where none exists — the button would break on its first use in
-- any new deployment.
--
-- So it goes in configurations, with today's values as defaults. That also ends
-- another hidden constant: which model scores the corpus was previously decided
-- by whoever last created a request in SQL, visible nowhere.
--
-- aggregation_strategy comes along for the same reason. It has exactly one legal
-- value today (scoring_apply_aggregation raises on anything else), but it is the
-- setting that decides a post's overall score from its themes — "the highest
-- single theme wins" — and it belongs beside the themes it combines rather than
-- buried in a request row.
-- -----------------------------------------------------------------------------
alter table public.configurations
  add column scoring_model text not null default 'gpt-5.4-nano',
  add column scoring_model_snapshot text not null default 'gpt-5.4-nano-2026-03-17',
  add column aggregation_strategy text not null default 'max_theme_v1';

comment on column public.configurations.scoring_model is
  'Model used for scoring. model_snapshot is the exact dated build pinned onto each request, so '
  'a result can always name what produced it even after the alias moves.';

comment on column public.configurations.aggregation_strategy is
  'How per-theme scores become one overall score. ''max_theme_v1'' takes the highest single '
  'theme — which is why a post scoring 95 on one theme and 0 on five others ranks alongside one '
  'strong across the board. Measured on real posts, that is what let an off-domain traineeship '
  'advert reach the top of the queue.';


-- -----------------------------------------------------------------------------
-- queue_scoring — put posts into the scoring queue
-- -----------------------------------------------------------------------------
-- p_mode:
--   'unscored'  posts that have never produced a score (the usual case)
--   'all'       every post, replacing existing scores — after a config change
-- -----------------------------------------------------------------------------
create or replace function public.queue_scoring(p_mode text default 'unscored')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id uuid;
  v_active_hash text;
  v_current_hash text;
  v_rotated boolean := false;
  v_count integer;
  v_model text;
  v_model_snapshot text;
  v_aggregation text;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and not (select public.is_editor()) then
    raise exception 'not authorised';
  end if;

  if p_mode not in ('unscored', 'all') then
    raise exception 'mode must be unscored or all';
  end if;

  v_current_hash := public.scoring_hash_of_snapshot(public.scoring_config_snapshot());

  select id, config_hash into v_request_id, v_active_hash
    from public.scoring_requests
   where status = 'active' and purpose = 'production'
   limit 1;

  -- A request's definition is immutable, so a changed objective needs a new one.
  -- Without this the operator edits themes or the domain, presses Score, and
  -- gets the previous configuration with no indication anything was ignored.
  if v_request_id is not null and v_active_hash is distinct from v_current_hash then
    perform public.close_scoring_request(v_request_id);
    v_request_id := null;
    v_rotated := true;
  end if;

  if v_request_id is null then
    select c.scoring_model, c.scoring_model_snapshot, c.aggregation_strategy
      into v_model, v_model_snapshot, v_aggregation
      from public.configurations c where c.id = 'default';
    if v_model is null then
      raise exception 'configurations row is missing; the pipeline needs one to score';
    end if;

    v_request_id := public.create_scoring_request(
      'production',
      public.scoring_prompt_version(),
      '',
      public.scoring_config_snapshot(),
      v_model, v_model_snapshot, v_aggregation,
      null
    );
    perform public.activate_scoring_request(v_request_id);
  end if;

  if p_mode = 'all' then
    v_count := public.enqueue_reevaluation(v_request_id);
  else
    v_count := public.backfill_scoring_for_request(v_request_id);
  end if;

  return jsonb_build_object(
    'request_id', v_request_id,
    'enqueued', v_count,
    'config_rotated', v_rotated,
    'queued_total', (select count(*) from public.scoring_job_state
                      where status in ('pending', 'processing'))
  );
end
$$;

comment on function public.queue_scoring is
  'Fills the scoring queue for the Score now button, opening or rotating the production '
  'scoring_request as needed. Rotates when the live config no longer hashes to the active '
  'request''s pinned snapshot — otherwise an objective change never reaches the scorer, '
  'because a request definition is immutable by design.';


-- -----------------------------------------------------------------------------
-- requeue_anonymisation — re-run anonymisation over already-processed posts
-- -----------------------------------------------------------------------------
-- Adding a brand name to company_aliases changes nothing on its own: the
-- anonymise backfill only picks up posts with no current result, so everything
-- already processed keeps the text it got under the OLD name list. Accepting a
-- discovered brand and seeing no effect is the confusing case this exists for.
--
-- Marking the job dead_letter rather than pending is not a trick: it is the
-- retry path backfill_anonymize_jobs already implements, whose on-conflict
-- clause fires only `where status = 'dead_letter'`. Setting pending instead
-- makes the row invisible to the backfill, which is exactly the dead end hit on
-- 2026-08-31.
-- -----------------------------------------------------------------------------
create or replace function public.requeue_anonymisation()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and not (select public.is_editor()) then
    raise exception 'not authorised';
  end if;

  with target as (
    select raw_post_id from public.anonymized_posts_current
     where current_result_id is not null
  ), cleared as (
    update public.anonymized_posts_current
       set current_result_id = null
     where raw_post_id in (select raw_post_id from target)
    returning raw_post_id
  )
  update public.anonymize_job_state
     set status = 'dead_letter', updated_at = now()
   where raw_post_id in (select raw_post_id from cleared);

  get diagnostics v_count = row_count;

  return jsonb_build_object(
    'requeued', v_count,
    'note', 'press Anonymise now to process them'
  );
end
$$;

comment on function public.requeue_anonymisation is
  'Marks every already-anonymised post for a fresh pass, so a newly accepted brand name '
  'actually reaches text that was processed before it existed. Does no LLM work itself — the '
  'operator then drains the queue in bounded batches as usual.';


-- =============================================================================
-- Grants — editor callable, like the other operator actions added in 0019/0020
-- =============================================================================
do $grants$
declare fn text;
begin
  foreach fn in array array[
    'queue_scoring(text)',
    'requeue_anonymisation()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end
$grants$;

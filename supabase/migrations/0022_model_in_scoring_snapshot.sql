-- 0022 — the model and the aggregation strategy belong in the config hash
--
-- 0021 moved scoring_model, scoring_model_snapshot and aggregation_strategy into
-- configurations so queue_scoring could read them, and so that "which model
-- scores this corpus" stopped being decided by whoever last wrote a request in
-- SQL. Session 16 puts them on the Objective screen, which exposes the half of
-- that change that was never finished.
--
-- queue_scoring rotates the active production request when the config hash
-- moves. The hash comes from scoring_config_snapshot(), which lists themes,
-- min_relevance_score, editorial_domain and prompt_version — and NOT the model.
-- So an operator could change the model, press Queue, and be scored by the old
-- one, with nothing anywhere saying so. That is precisely the failure 0021's
-- rotation clause exists to prevent; it just did not cover these two columns.
--
-- Both belong in the snapshot on their own merits: a scoring_request already
-- pins model, model_snapshot and aggregation_strategy as immutable fields,
-- because they change what a score MEANS. A hash that omits them can call two
-- materially different requests equivalent.
--
-- One-time effect: this changes the hash for the current configuration, so the
-- next queue_scoring call rotates the production request once even if nobody
-- edits anything. That costs nothing. backfill_scoring_for_request enqueues
-- posts with no current result at all (analyzed_posts.current_result_id is
-- null), not posts unscored under the new request, so the 180 existing scores
-- are not re-run. Only an explicit "Re-score all" does that.
create or replace function public.scoring_config_snapshot()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'themes', public.scoring_theme_snapshot(),
    'min_relevance_score', (select min_relevance_score from public.configurations where id = 'default'),
    'editorial_domain', (select editorial_domain from public.configurations where id = 'default'),
    'scoring_model', (select scoring_model from public.configurations where id = 'default'),
    'aggregation_strategy', (select aggregation_strategy from public.configurations where id = 'default'),
    'prompt_version', public.scoring_prompt_version()
  )
$$;

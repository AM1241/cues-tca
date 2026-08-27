-- =============================================================================
-- 0018_scoring_promote_on_complete.sql — close the scoring promotion gap
-- =============================================================================
--
-- Scoring is a two-step write by design: complete_scoring_job appends to the
-- immutable scoring_results history, and set_current_scoring_result projects a
-- chosen result onto analyzed_posts — the table the UI and every downstream
-- stage actually read. 0005 kept them separate deliberately, so that promoting
-- is an explicit decision rather than a side effect of scoring.
--
-- Nothing ever called the second step. score-worker calls read_scoring_jobs,
-- complete_scoring_job and record_scoring_failure, and stops there. The result:
-- every post the worker scored produced a correct scoring_results row that was
-- invisible to the product, because analyzed_posts never learned about it.
-- Found in cloud on 2026-08-27: 6 real llm_verified results existed with no
-- analyzed_posts row at all, while all 133 rows the UI displayed still pointed
-- at the legacy 'simulated' scores. Draining the queue in that state would have
-- produced more invisible history and looked like a broken deploy.
--
-- Why this is fixed in the database rather than in the worker:
-- complete_scoring_job marks the job succeeded AND archives its pgmq message.
-- A worker that promoted afterwards, in a second round trip, would leave the
-- post unpromoted forever if that second call failed — the job is already gone
-- from the queue, so no later drain re-claims it. Wrapping both in one function
-- makes them one transaction: either the history row and the projection both
-- land, or neither does and the message stays claimable.
--
-- complete_scoring_job itself is untouched. The backfill path
-- (backfill_scoring_for_request) already promotes inline and keeps working as
-- it did; this only gives the worker path the same guarantee.
-- =============================================================================

create or replace function public.complete_and_promote_scoring_job(
  p_job_id uuid,
  p_msg_id bigint,
  p_raw_post_id uuid,
  p_scoring_request_id uuid,
  p_theme_scores jsonb,
  p_reason text,
  p_provider_response jsonb default null,
  p_processing_token uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_outcome text;
  v_result_id uuid;
begin
  v_outcome := public.complete_scoring_job(
    p_job_id, p_msg_id, p_raw_post_id, p_scoring_request_id,
    p_theme_scores, p_reason, p_provider_response, p_processing_token
  );

  -- 'superseded' means a newer worker owns this job — it will produce (and
  -- promote) its own result, so promoting here would publish a result this
  -- caller no longer owns.
  if v_outcome not in ('inserted', 'duplicate') then
    return v_outcome;
  end if;

  -- 'duplicate' still promotes: the history row exists but analyzed_posts may
  -- not have caught up, and set_current_scoring_result is an idempotent upsert.
  select id into v_result_id
    from public.scoring_results
   where raw_post_id = p_raw_post_id
     and scoring_request_id = p_scoring_request_id
   order by created_at desc
   limit 1;

  if v_result_id is null then
    raise exception
      'complete_scoring_job returned % but no scoring_result exists for raw_post % / request %',
      v_outcome, p_raw_post_id, p_scoring_request_id;
  end if;

  perform public.set_current_scoring_result(p_raw_post_id, v_result_id);

  return v_outcome;
end
$$;

comment on function public.complete_and_promote_scoring_job is
  'Completes a scoring job and projects its result onto analyzed_posts in one transaction. '
  'Exists because complete_scoring_job archives the job''s queue message: a worker promoting in '
  'a separate round trip would strand the post unpromoted if that second call failed, with no '
  'message left to re-claim. Returns complete_scoring_job''s own outcome unchanged '
  '(inserted / duplicate / superseded); only inserted and duplicate promote.';

revoke all on function public.complete_and_promote_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.complete_and_promote_scoring_job(uuid,bigint,uuid,uuid,jsonb,text,jsonb,uuid)
  to service_role;

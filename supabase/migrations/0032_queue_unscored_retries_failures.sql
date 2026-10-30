-- =============================================================================
-- 0032_queue_unscored_retries_failures.sql — a failed post is not stuck for good
-- =============================================================================
--
-- backfill_scoring_for_request skips every post that already has a job under the
-- request, and a job stays behind after it dead-letters. So a post that failed
-- three times, or during an OpenAI outage, could never be queued again: "Queue
-- unscored" found nothing to do and the screen answered "every post already has a
-- score" about a post that had none. Only a changed setting got it out, by
-- opening a new request.
--
-- The backfill now also revives dead-lettered jobs of posts that still have no
-- score. That makes the answer true: when it queues nothing and nothing is
-- waiting, every post really has one.
--
-- A refusal will usually refuse again, which is why the worker does not retry it
-- by itself. Here a person asked, so it gets its one more call each time they do.
-- revive_scoring_job clears the failure count and leaves the scoring_dead_letter
-- row as the record of what happened.
-- =============================================================================

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

  for r in
    select js.id from public.scoring_job_state js
    left join public.analyzed_posts ap on ap.raw_post_id = js.raw_post_id
    where js.scoring_request_id = p_request_id
      and js.status = 'dead_letter'
      and ap.current_result_id is null
  loop
    perform public.revive_scoring_job(r.id);
    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

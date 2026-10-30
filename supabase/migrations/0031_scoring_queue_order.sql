-- =============================================================================
-- 0031_scoring_queue_order.sql — new posts first, and no jobs left behind
-- =============================================================================
--
-- Tecnoalimenti reported on 2026-10-29 that Rating was not working and that this
-- blocked every later step. Nothing was failing. On 2026-10-02 a batch of 181
-- old, already-scored posts entered the queue (only "Re-score all" does that),
-- and pgmq reads strictly in arrival order, so from then on every "Score now"
-- re-scored old posts. Of the 100 results written after 2026-10-16, 99 were for
-- posts that already had a score, while 317 new posts waited behind the rest of
-- the batch. Those old posts fall outside Rating's 15-day window, so the screen
-- answered "10 scored" and did not change. Topics had nothing to work with.
--
-- Two changes:
--
-- 1. read_scoring_jobs serves the posts that matter first, instead of pgmq.read's
--    fixed `order by msg_id`: never-scored posts ahead of re-scores, newest first
--    within each. That is the question "Score now" is actually being asked. A
--    re-score can no longer stand between an editor and this week's posts, and
--    the cap of ten per click now buys the ten most useful posts.
--
-- 2. queue_scoring no longer abandons jobs when it rotates the request.
--    close_scoring_request only flips the status: the replaced request's pending
--    jobs stayed in the queue, score-worker refuses a job under a closed request
--    without archiving it, and the lease expiry put it straight back. With 271
--    jobs waiting, one settings change followed by "Queue unscored" left the same
--    ten dead jobs at the head of the queue for good, each click reporting
--    "0 scored". Reproduced locally; it had not yet happened in production.
--    cancel_scoring_request_siblings already terminalizes and archives exactly
--    this set for a circuit-break, so rotation goes through it too.
--
-- The worker's own "request is closed" guard stays: it still catches a request
-- closed by another worker between this read and the paid call.
-- =============================================================================


-- 1. read_scoring_jobs — same claim, better order ------------------------------
-- The select, lease and read_ct update are what pgmq.read does (1.5.1), with the
-- order changed. Worked on the queue table directly because pgmq.read offers no
-- way to choose the order. raw_posts is a left join so an orphan message, whose
-- post is gone, still surfaces (nulls first) and reaches the archive branch below
-- rather than sitting in the queue forever.
create or replace function public.read_scoring_jobs(p_vt integer, p_qty integer)
returns table (msg_id bigint, message jsonb, processing_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; v_token uuid;
begin
  for r in
    select q.msg_id, q.message
      from pgmq.q_scoring_jobs q
      left join public.raw_posts rp on rp.id = (q.message ->> 'raw_post_id')::uuid
      left join public.analyzed_posts ap on ap.raw_post_id = rp.id
     where q.vt <= clock_timestamp()
     order by (ap.current_result_id is not null), rp.published_at desc nulls first, q.msg_id
     limit p_qty
       for update of q skip locked
  loop
    update pgmq.q_scoring_jobs m
       set vt = clock_timestamp() + make_interval(secs => p_vt),
           read_ct = m.read_ct + 1
     where m.msg_id = r.msg_id;

    v_token := gen_random_uuid();
    update public.scoring_job_state
       set processing_token = v_token, status = 'processing',
           leased_at = now(), msg_id = r.msg_id, updated_at = now()
     where id = (r.message ->> 'job_id')::uuid
       and status in ('pending', 'processing');
    if found then
      msg_id := r.msg_id; message := r.message; processing_token := v_token;
      return next;
    else
      -- Orphan message: the job row is gone or already terminal, so nothing
      -- downstream will ever complete it. Archive it rather than let it be
      -- re-read on every drain forever.
      perform pgmq.archive('scoring_jobs', r.msg_id);
    end if;
  end loop;
end
$$;
revoke all on function public.read_scoring_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.read_scoring_jobs(integer, integer) to service_role;

comment on function public.read_scoring_jobs is
  'Claims a batch of scoring jobs: never-scored posts before re-scores, newest first within each. '
  'Not pgmq.read, whose fixed arrival order let a re-score backlog stand in front of every new post.';


-- 2. queue_scoring — rotation cancels what it replaces -------------------------
-- Unchanged from 0021 but for the rotation branch. The random id means "no
-- triggering job": every pending and processing job of the old request is
-- terminalized and its message archived. A job dead-lettered here with
-- 'request_rotated' lost nothing that matters: a never-scored post has no job
-- under the new request, so the backfill below queues it again.
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
    perform public.cancel_scoring_request_siblings(v_request_id, gen_random_uuid(), 'request_rotated');
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

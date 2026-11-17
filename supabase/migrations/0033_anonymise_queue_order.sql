-- =============================================================================
-- 0033_anonymise_queue_order.sql — new posts first in the anonymise queue too
-- =============================================================================
--
-- The same fault 0031 fixed for scoring, one step later. read_anonymize_jobs
-- (0014) is a plain pgmq.read, strictly `order by msg_id`, and "Anonymise now"
-- drains five per click by default. Read from production on 2026-11-17: 145
-- jobs pending, enqueued from 2026-07-24 onward, and the first post published
-- after 2026-10-02 at position 97. Every carousel made since 2026-11-02 came from
-- the 2026-10-02 grouping, because none of the posts scored since could reach
-- Topics: about twenty clicks of old posts stood in front of each new one, each
-- a paid entity-extraction call.
--
-- read_anonymize_jobs now serves posts never anonymised before re-anonymisations
-- ("Redo all", requeue_anonymisation), newest published first within each, then
-- arrival order. Nothing is removed: the old jobs stay queued and are reached
-- once the newer ones are done. The claim itself (lease, read_ct, processing
-- token, orphan archive) is unchanged from 0014, written out the way 0031 did
-- for scoring, because pgmq.read offers no way to choose the order.
--
-- "Anonymised before" is the existence of an anonymized_posts_current row, not
-- a non-null current_result_id: requeue_anonymisation (0021) nulls exactly that
-- column, so after "Redo all" a re-anonymisation and a first one look the same
-- by it. On production on 2026-11-17, 105 of the 110 rows had been nulled that
-- way, and of the 145 pending jobs 100 were re-anonymisations, 45 first ones.
-- =============================================================================

create or replace function public.read_anonymize_jobs(p_vt integer, p_qty integer)
returns table (msg_id bigint, message jsonb, processing_token uuid)
language plpgsql security definer set search_path = '' as $$
declare r record; v_token uuid;
begin
  for r in
    -- raw_posts is a left join so an orphan message, whose post is gone, still
    -- surfaces (nulls first) and reaches the archive branch below.
    select q.msg_id, q.message
      from pgmq.q_anonymize_jobs q
      left join public.raw_posts rp on rp.id = (q.message ->> 'raw_post_id')::uuid
      left join public.anonymized_posts_current apc on apc.raw_post_id = rp.id
     where q.vt <= clock_timestamp()
     order by (apc.raw_post_id is not null), rp.published_at desc nulls first, q.msg_id
     limit p_qty
       for update of q skip locked
  loop
    update pgmq.q_anonymize_jobs m
       set vt = clock_timestamp() + make_interval(secs => p_vt),
           read_ct = m.read_ct + 1
     where m.msg_id = r.msg_id;

    v_token := gen_random_uuid();
    update public.anonymize_job_state
       set processing_token = v_token, status = 'processing',
           leased_at = now(), msg_id = r.msg_id, updated_at = now()
     where id = (r.message ->> 'job_id')::uuid
       and status in ('pending', 'processing');
    if found then
      msg_id := r.msg_id; message := r.message; processing_token := v_token;
      return next;
    else
      -- Orphan message: job row gone or already terminal. Archive so it's not
      -- re-read forever.
      perform pgmq.archive('anonymize_jobs', r.msg_id);
    end if;
  end loop;
end
$$;
revoke all on function public.read_anonymize_jobs(integer, integer) from public, anon, authenticated;
grant execute on function public.read_anonymize_jobs(integer, integer) to service_role;

comment on function public.read_anonymize_jobs is
  'Claims a batch of anonymise jobs: never-anonymised posts before re-anonymisations, newest first within each. '
  'Not pgmq.read, whose fixed arrival order put a backlog of old posts in front of every new one.';

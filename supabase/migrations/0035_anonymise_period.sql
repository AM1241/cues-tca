-- =============================================================================
-- 0035_anonymise_period.sql — "Anonymise now" works on the working period
-- =============================================================================
--
-- Asked for by the operator on 2026-11-20: Run clustering only groups the posts
-- published in the working period, but Anonymise now drained the whole queue,
-- newest first across every date (0033). With a short period, or one in the
-- past, the clicks went to posts that the next grouping could not use, and each
-- one is a paid entity-extraction call.
--
-- read_anonymize_jobs gains an optional publication window, [p_from, p_to). When
-- it is given, only jobs whose post was published inside it are claimed; the
-- others stay queued, untouched, for a later period. Without it the function
-- behaves exactly as 0033 (same order, same claim, orphan messages archived), so
-- every caller that passes only p_vt and p_qty — the classic Topics screen, the
-- tests, an operator's backfill drain — is unchanged.
--
-- The argument list changes, which create or replace cannot do, so the 0033
-- function is dropped and recreated in the same transaction. The new parameters
-- default to null, so a call with p_vt and p_qty alone still resolves, and the
-- deployed worker keeps working between this migration and its own deploy.
--
-- An orphan message (its post deleted) has no publication date, so a windowed
-- read never sees it; the next read without a window archives it, as before.
-- =============================================================================

drop function public.read_anonymize_jobs(integer, integer);

create function public.read_anonymize_jobs(
  p_vt integer,
  p_qty integer,
  p_from timestamptz default null,
  p_to timestamptz default null
)
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
       and (p_from is null or rp.published_at >= p_from)
       and (p_to is null or rp.published_at < p_to)
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
revoke all on function public.read_anonymize_jobs(integer, integer, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.read_anonymize_jobs(integer, integer, timestamptz, timestamptz) to service_role;

comment on function public.read_anonymize_jobs(integer, integer, timestamptz, timestamptz) is
  'Claims a batch of anonymise jobs: never-anonymised posts before re-anonymisations, newest first within each. '
  'With p_from/p_to, only posts published in [p_from, p_to) are claimed; the rest stay queued (0035).';

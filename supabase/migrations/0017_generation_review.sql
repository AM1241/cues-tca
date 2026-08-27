-- =============================================================================
-- 0017_generation_review.sql — Phase 7: review state for generated copy
-- =============================================================================
--
-- 0016 deliberately stopped reading and writing 0001's editorial_assets, but
-- the Review and Export routes never followed — they still read
-- editorial_assets while `generate` writes cluster_generation_results. The
-- result: everything the pipeline produces is unreachable to an editor, and
-- Export opens empty because nothing can ever reach 'approved'. This migration
-- closes that gap.
--
-- Why a separate table rather than columns on cluster_generation_results:
-- that table is append-only, enforced by the cluster_generation_results_no_update
-- / _no_delete triggers in 0016, and deliberately so — a result is an exact
-- immutable snapshot of what the LLM produced from which inputs under which
-- prompt. Review state is the opposite: mutable by definition. So review lives
-- in its own projection over the immutable results, the same relationship
-- anonymized_posts_current has to anonymize_results.
--
-- Key decisions this schema encodes:
--
--   - Granularity is (result_id, output_type), not result_id. One result can
--     carry both a post and a carousel, and they are shipped separately — a
--     post can be approved while its carousel is still being worked on. A
--     single decision covering both would force an editor to reject usable
--     copy to reject its companion.
--   - Editing never mutates the generated output. edited_output holds the
--     editor's version; null means "use the original". The LLM's own words stay
--     on cluster_generation_results forever, so "what did the model actually
--     write" and "what did we publish" remain separately answerable — which is
--     also what makes llm_used-style provenance meaningful downstream.
--   - Rows are created by the database, never by an editor. An after-insert
--     trigger on cluster_generation_results creates one draft row per output
--     type, mirroring 0002's rule for editorial_assets: insertion is what the
--     pipeline does, and a review row with no result behind it would be a
--     review of nothing.
--   - Editors get a COLUMN-LEVEL update grant, not a table-wide one. See the
--     grants block for exactly why.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- cluster_generation_reviews — mutable review state over immutable results
-- -----------------------------------------------------------------------------
create table public.cluster_generation_reviews (
  result_id           uuid not null references public.cluster_generation_results (id) on delete restrict,
  output_type         text not null check (output_type in ('post', 'carousel')),

  -- Same vocabulary as editorial_assets.status so the Export status filter
  -- means the same thing on both tabs.
  status              text not null default 'draft'
                        check (status in ('draft', 'approved', 'rejected', 'published')),

  -- The editor's version of this output, in the same JSON shape as the
  -- corresponding post_output / carousel_output. Null means untouched: read
  -- the original off cluster_generation_results.
  edited_output       jsonb,

  approved_by         uuid references auth.users (id) on delete set null,
  approval_timestamp  timestamptz,
  approval_notes      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  primary key (result_id, output_type)
);

comment on table public.cluster_generation_reviews is
  'Mutable review state for one generated output, keyed (result_id, output_type). A projection '
  'over the append-only cluster_generation_results — the generated copy itself is never '
  'modified; an editor''s rewrite lands in edited_output, leaving the model''s original intact '
  'and comparable. Rows are created by trigger when a result is inserted, never by an editor.';

comment on column public.cluster_generation_reviews.edited_output is
  'Editor''s replacement for this output, same JSON shape as the result''s post_output / '
  'carousel_output. Null means no edit — consumers read the original from the result row.';

create index cluster_generation_reviews_status_idx on public.cluster_generation_reviews (status);
create index cluster_generation_reviews_updated_idx on public.cluster_generation_reviews (updated_at desc);

create trigger cluster_generation_reviews_set_updated_at
  before update on public.cluster_generation_reviews
  for each row execute function public.set_updated_at();


-- -----------------------------------------------------------------------------
-- output_type must exist on the parent result
-- -----------------------------------------------------------------------------
-- The composite FK cannot express this: output_types is an array column on
-- cluster_generation_results, so "output_type is one of the parent's output
-- types" needs a lookup. Same reasoning and shape as
-- cluster_assignments_run_consistency in 0015 — a review of an output the
-- result does not carry would render as an empty card with working approve
-- buttons, which is worse than an error.
-- -----------------------------------------------------------------------------
create or replace function public.cluster_generation_reviews_output_consistency()
returns trigger language plpgsql as $$
declare v_output_types text[];
begin
  select output_types into v_output_types
    from public.cluster_generation_results where id = new.result_id;
  if v_output_types is null then
    raise exception 'cluster_generation_result % not found', new.result_id;
  end if;
  if not (new.output_type = any(v_output_types)) then
    raise exception 'cluster_generation_result % has no % output (has %)',
      new.result_id, new.output_type, v_output_types;
  end if;
  return new;
end
$$;

create trigger cluster_generation_reviews_output_consistency_check
  before insert or update on public.cluster_generation_reviews
  for each row execute function public.cluster_generation_reviews_output_consistency();


-- -----------------------------------------------------------------------------
-- Auto-create one draft review row per output when a result lands
-- -----------------------------------------------------------------------------
-- Editors have no INSERT grant, so this is the only way review rows come into
-- existence. Doing it here rather than in the generate function means a result
-- is never reviewable-in-principle-but-missing-a-row, including for rows
-- written by any future backfill or repair path.
-- -----------------------------------------------------------------------------
create or replace function public.cluster_generation_results_seed_reviews()
returns trigger language plpgsql as $$
begin
  insert into public.cluster_generation_reviews (result_id, output_type)
  select new.id, ot from unnest(new.output_types) as ot
  on conflict (result_id, output_type) do nothing;
  return null;
end
$$;

create trigger cluster_generation_results_seed_reviews_after_insert
  after insert on public.cluster_generation_results
  for each row execute function public.cluster_generation_results_seed_reviews();

-- Backfill the results that predate this migration.
insert into public.cluster_generation_reviews (result_id, output_type)
select r.id, ot
from public.cluster_generation_results r,
     unnest(r.output_types) as ot
on conflict (result_id, output_type) do nothing;


-- =============================================================================
-- Privileges — editors read everything and write only review decisions
-- =============================================================================
alter table public.cluster_generation_reviews enable row level security;

revoke all on public.cluster_generation_reviews from anon, authenticated;

grant select on public.cluster_generation_reviews to authenticated;
grant select, insert, update on public.cluster_generation_reviews to service_role;

revoke truncate, trigger, references on public.cluster_generation_reviews
  from service_role, authenticated, anon;

create policy cluster_generation_reviews_select_for_editors
  on public.cluster_generation_reviews for select to authenticated
  using ((select public.is_editor()));

-- The row-level predicate. Which COLUMNS may be touched is enforced separately
-- by the column-level grant below — a policy cannot express that. The extra
-- with-check stops an editor recording an approval in someone else's name,
-- exactly as editorial_assets_update_for_editors does in 0002.
create policy cluster_generation_reviews_update_for_editors
  on public.cluster_generation_reviews for update to authenticated
  using ((select public.is_editor()))
  with check (
    (select public.is_editor())
    and (approved_by is null or approved_by = (select auth.uid()))
  );

-- COLUMN-LEVEL update. A table-wide grant would let an editor repoint
-- result_id at a different result, or rewrite output_type / created_at —
-- i.e. move an approval onto copy that was never reviewed. Recording a
-- decision and editing the copy are the only things a reviewer legitimately
-- does, so those are the only columns granted. Postgres rejects an UPDATE
-- touching any ungranted column with "permission denied", regardless of what
-- the RLS policy says.
--
-- Deliberately omitted: result_id, output_type, created_at, updated_at.
-- No INSERT and no DELETE for authenticated at all — rows appear with their
-- result and outlive any individual review decision.
grant update (
  status,
  edited_output,
  approved_by,
  approval_timestamp,
  approval_notes
) on public.cluster_generation_reviews to authenticated;

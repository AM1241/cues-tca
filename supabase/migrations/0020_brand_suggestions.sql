-- =============================================================================
-- 0020_brand_suggestions.sql — names the anonymiser cannot derive
-- =============================================================================
--
-- Anonymisation knows one thing about a company: its source label. From
-- "Fratelli Branca Distillerie LinkedIn" it derives the full name and its parts.
-- It cannot know that Carpano, Fernet-Branca, Punt e Mes, Antica Formula and
-- Museo Branca are the same company — product brands, a historical formula, a
-- museum. Nothing in the label implies any of them.
--
-- Stage 2 does not close the gap: its prompt tells the model to skip "the
-- source's own name", so these fall between the two stages and are caught by
-- neither. That leaked four company names on 2026-08-31; the repair was a human
-- reading the posts and typing six names into configurations.company_aliases.
-- That is a fix, not a mechanism — it needed a leak to trigger it, it covers
-- four sources, and the next source added starts the cycle over.
--
-- This table is where an automated reading of a source's own posts lands, as
-- PROPOSALS. Nothing reaches the anonymiser until an editor accepts.
--
-- Why proposals rather than direct writes: the failure that matters is not a
-- missed brand but a proposed CATEGORY. "Vermouth" or "Amaro" in the alias list
-- turns every mention of the product into "a food-sector organization" and
-- destroys the copy — and the repo already records stage-2 over-replacement
-- (regions, "Made in Italy", people) as a live quality problem. Adding a name is
-- cheap; discovering weeks later that generated copy is nonsense is not.
--
-- Rejections are remembered for the same reason a suggestion is: without that,
-- every re-run re-proposes the same category and the operator dismisses it
-- forever.
-- =============================================================================

create table public.brand_suggestions (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null references public.sources (id) on delete cascade,

  name        text not null,
  -- One line from the model on why this name identifies the company. The
  -- operator is being asked to make a judgement; a bare list of words does not
  -- give them enough to make it.
  rationale   text,

  status      text not null default 'pending'
                check (status in ('pending', 'accepted', 'rejected')),

  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references auth.users (id) on delete set null,

  constraint brand_suggestions_name_not_blank check (length(btrim(name)) > 0)
);

-- Case-insensitive, so a re-run cannot re-propose "carpano" beside "Carpano".
-- This is what makes discovery idempotent and a rejection permanent.
create unique index brand_suggestions_source_name_idx
  on public.brand_suggestions (source_id, lower(name));

create index brand_suggestions_status_idx on public.brand_suggestions (status, created_at desc);

comment on table public.brand_suggestions is
  'Names proposed by discover-brands as identifying a source''s company, awaiting an editor''s '
  'decision. Accepting writes the name into configurations.company_aliases, which is what the '
  'anonymiser reads; rejecting keeps it from being proposed again. Nothing here affects '
  'anonymisation on its own.';


-- =============================================================================
-- Decisions — two writes that must not diverge, so one transaction each
-- =============================================================================

create or replace function public.accept_brand_suggestion(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.brand_suggestions%rowtype;
  v_replacement text;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and not (select public.is_editor()) then
    raise exception 'not authorised';
  end if;

  select * into v_row from public.brand_suggestions where id = p_id for update;
  if not found then raise exception 'brand_suggestion % not found', p_id; end if;
  if v_row.status <> 'pending' then
    raise exception 'brand_suggestion % is already %', p_id, v_row.status;
  end if;

  -- The replacement wording is the operator's configured generic entity, so an
  -- accepted brand reads the same as every other anonymised company. They can
  -- still change it per-name afterwards on the Objective screen.
  select domain_generic_entity into v_replacement
    from public.configurations where id = 'default';
  if v_replacement is null then
    raise exception 'configurations.domain_generic_entity is not set';
  end if;

  update public.configurations
     set company_aliases = coalesce(company_aliases, '{}'::jsonb)
                           || jsonb_build_object(btrim(v_row.name), v_replacement),
         updated_at = now()
   where id = 'default';

  update public.brand_suggestions
     set status = 'accepted', decided_at = now(), decided_by = (select auth.uid())
   where id = p_id;
end
$$;

comment on function public.accept_brand_suggestion is
  'Accepts one proposed name and adds it to configurations.company_aliases in the same '
  'transaction, so the decision and the thing the anonymiser actually reads can never '
  'disagree.';

create or replace function public.reject_brand_suggestion(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if coalesce((select auth.role()), '') <> 'service_role'
     and not (select public.is_editor()) then
    raise exception 'not authorised';
  end if;

  select status into v_status from public.brand_suggestions where id = p_id for update;
  if v_status is null then raise exception 'brand_suggestion % not found', p_id; end if;
  if v_status <> 'pending' then
    raise exception 'brand_suggestion % is already %', p_id, v_status;
  end if;

  update public.brand_suggestions
     set status = 'rejected', decided_at = now(), decided_by = (select auth.uid())
   where id = p_id;
end
$$;

comment on function public.reject_brand_suggestion is
  'Rejects one proposed name. The row is kept, not deleted: the unique (source_id, lower(name)) '
  'index is what stops a later discovery run proposing it again.';


-- =============================================================================
-- Privileges — editors read and decide; only the function inserts
-- =============================================================================
alter table public.brand_suggestions enable row level security;

revoke all on public.brand_suggestions from anon, authenticated;

grant select on public.brand_suggestions to authenticated;
grant select, insert, update on public.brand_suggestions to service_role;

revoke truncate, trigger, references on public.brand_suggestions
  from service_role, authenticated, anon;

create policy brand_suggestions_select_for_editors
  on public.brand_suggestions for select to authenticated
  using ((select public.is_editor()));

-- No INSERT, UPDATE or DELETE grant for authenticated at all: a proposal comes
-- from discover-brands reading real posts, and a decision goes through the RPCs
-- above so it cannot be recorded without the alias write that must accompany it.

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'accept_brand_suggestion(uuid)',
    'reject_brand_suggestion(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end
$grants$;

-- =============================================================================
-- 0025 — adding a source, and editing its configuration, is admin-only
-- =============================================================================
-- public.editors has carried a role column ('editor' | 'admin', 0002) since
-- the very first migration, and hzafeiris@f-in.eu is already seeded as
-- 'admin' — but nothing has ever read it. Every editor has had identical
-- privileges regardless of role.
--
-- The operator's request: adding a new source, and changing what it points at
-- (name, url, type, rapidapi_identifier, company_name), is an admin action —
-- get that wrong and every downstream stage silently reads the wrong LinkedIn
-- page. Adjusting lookback_days is routine editorial judgement ("look back
-- further this week") and stays open to every editor. So does the enabled
-- toggle: pausing or resuming collection is routine day-to-day operation, not
-- configuration — kept open to every editor on the operator's explicit call.
--
-- RLS alone cannot express "any editor may update lookback_days and enabled,
-- only an admin may touch the rest": editor and admin are both the Postgres
-- role `authenticated`, so there is no per-row column-level GRANT to lean on
-- (unlike the service_role/authenticated split used for
-- cluster_generation_reviews in 0017). A BEFORE UPDATE trigger does the
-- column-level check instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- is_admin() — mirrors is_editor() (0002), narrowed to role = 'admin'
-- -----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.editors e
     where e.user_id = (select auth.uid()) and e.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

comment on function public.is_admin() is
  'True when the current user is on the editors allowlist with role = admin. '
  'SECURITY DEFINER to avoid RLS recursion, same as is_editor().';

-- -----------------------------------------------------------------------------
-- Insert: creating a source is admin-only
-- -----------------------------------------------------------------------------
drop policy if exists sources_insert_for_editors on public.sources;

create policy sources_insert_for_admins
  on public.sources for insert to authenticated
  with check ((select public.is_admin()));

-- -----------------------------------------------------------------------------
-- Update: any editor may still attempt one (needed for lookback_days and
-- enabled); the trigger below is what actually restricts a non-admin's edit
-- to those two columns.
-- -----------------------------------------------------------------------------
-- sources_update_for_editors (0002) is left as-is: `using`/`with check
-- ((select public.is_editor()))` already allows any editor through RLS.

create or replace function public.enforce_source_edit_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select public.is_admin()) then
    return new;
  end if;

  -- A non-admin may change lookback_days and enabled. Every other column
  -- must arrive unchanged, or the update is rejected outright — not silently
  -- reverted, which would leave the caller believing an edit succeeded.
  if new.name is distinct from old.name
     or new.source_type is distinct from old.source_type
     or new.url is distinct from old.url
     or new.company_name is distinct from old.company_name
     or new.rapidapi_identifier is distinct from old.rapidapi_identifier
     or new.collection_frequency is distinct from old.collection_frequency
  then
    raise exception
      'only an admin may change name, type, url, company_name, rapidapi_identifier or collection_frequency'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_source_edit_scope() is
  'Column-level half of the admin lock RLS cannot express: editor and admin are '
  'the same Postgres role, so this trigger — not a GRANT — is what confines a '
  'non-admin''s update to lookback_days and enabled.';

create trigger trg_enforce_source_edit_scope
  before update on public.sources
  for each row
  execute function public.enforce_source_edit_scope();

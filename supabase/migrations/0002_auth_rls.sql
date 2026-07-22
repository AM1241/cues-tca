-- =============================================================================
-- 0002_auth_rls.sql — editors allowlist and row level security
-- =============================================================================
--
-- The legacy system had no authentication at all and ran CORS with
-- allow_origins=["*"]. On a public Netlify URL that is not acceptable.
--
-- Access model:
--
--   anon           — denied everywhere. The publishable key ships in the browser
--                    bundle, so anything readable by anon is readable by the
--                    world. No table grants a policy to anon.
--
--   authenticated  — must ALSO be present in public.editors. Being logged in is
--                    not enough; the allowlist is the authorisation boundary.
--                    Read access to pipeline output, write access only to the
--                    things editors actually operate: sources, the config row,
--                    and the review fields on assets.
--
--   service_role   — used exclusively by Edge Functions, bypasses RLS entirely.
--                    Every pipeline write path (ingest, score, anonymize,
--                    generate) runs as service_role. No policies are needed for
--                    it, and none are written; granting RLS policies to
--                    service_role would be misleading.
--
-- RLS is enabled on every table in this schema. A table without policies denies
-- everything to anon and authenticated, which is the correct failure mode.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Table-level privileges
-- -----------------------------------------------------------------------------
-- This Postgres ships secure-by-default: newly created tables grant only
-- REFERENCES/TRIGGER/TRUNCATE to anon, authenticated and service_role — no DML
-- at all. Privileges are checked BEFORE row level security, so a table with
-- perfect policies and no GRANT is simply inaccessible ("permission denied for
-- table ..."), and service_role cannot write despite bypassing RLS.
--
-- So grants and policies have to agree. The rule used here:
--   anon          — nothing, ever. Explicitly revoked below.
--   authenticated — exactly the DML its policies allow, no more. The policy is
--                   the authorisation check; the grant is what lets it run.
--   service_role  — full DML, since every Edge Function writes as this role.
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

-- Belt and braces: the publishable key is public, so anon gets nothing.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;


-- -----------------------------------------------------------------------------
-- editors — the allowlist
-- -----------------------------------------------------------------------------
create table public.editors (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'editor' check (role in ('editor', 'admin')),
  created_at timestamptz not null default now()
);

comment on table public.editors is
  'Allowlist of authorised editors. Presence here, not merely being authenticated, grants access.';

alter table public.editors enable row level security;


-- -----------------------------------------------------------------------------
-- is_editor() — the predicate every policy is built on
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER so that evaluating it does not itself trigger RLS on
-- public.editors, which would recurse. search_path is pinned to empty and every
-- object is schema-qualified, so the function cannot be hijacked by a caller
-- setting a different search_path.
-- -----------------------------------------------------------------------------
create or replace function public.is_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.editors e where e.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_editor() from public;
grant execute on function public.is_editor() to authenticated;

comment on function public.is_editor() is
  'True when the current user is on the editors allowlist. SECURITY DEFINER to avoid RLS recursion.';


-- -----------------------------------------------------------------------------
-- editors policies
-- -----------------------------------------------------------------------------
-- Editors may see the team. Only service_role may change who is on the list —
-- an allowlist that its members can edit is not an allowlist.
create policy editors_select_for_editors
  on public.editors for select
  to authenticated
  using ((select public.is_editor()));


-- -----------------------------------------------------------------------------
-- Pipeline tables — read-only for editors, written by service_role
-- -----------------------------------------------------------------------------
alter table public.raw_posts               enable row level security;
alter table public.normalized_posts        enable row level security;
alter table public.analyzed_posts          enable row level security;
alter table public.anonymized_posts_current enable row level security;
alter table public.generation_requests     enable row level security;
alter table public.traceability_links      enable row level security;
alter table public.traceability_link_posts enable row level security;

create policy raw_posts_select_for_editors
  on public.raw_posts for select to authenticated
  using ((select public.is_editor()));

create policy normalized_posts_select_for_editors
  on public.normalized_posts for select to authenticated
  using ((select public.is_editor()));

create policy analyzed_posts_select_for_editors
  on public.analyzed_posts for select to authenticated
  using ((select public.is_editor()));

create policy anonymized_posts_select_for_editors
  on public.anonymized_posts_current for select to authenticated
  using ((select public.is_editor()));

create policy traceability_links_select_for_editors
  on public.traceability_links for select to authenticated
  using ((select public.is_editor()));

create policy traceability_link_posts_select_for_editors
  on public.traceability_link_posts for select to authenticated
  using ((select public.is_editor()));

-- generation_requests: editors may read all, and create their own. The row's
-- created_by must be the caller, so an editor cannot forge another's request.
create policy generation_requests_select_for_editors
  on public.generation_requests for select to authenticated
  using ((select public.is_editor()));

create policy generation_requests_insert_for_editors
  on public.generation_requests for insert to authenticated
  with check ((select public.is_editor()) and created_by = (select auth.uid()));


-- -----------------------------------------------------------------------------
-- sources — editors manage these from the UI
-- -----------------------------------------------------------------------------
alter table public.sources enable row level security;

create policy sources_select_for_editors
  on public.sources for select to authenticated
  using ((select public.is_editor()));

create policy sources_insert_for_editors
  on public.sources for insert to authenticated
  with check ((select public.is_editor()));

create policy sources_update_for_editors
  on public.sources for update to authenticated
  using ((select public.is_editor()))
  with check ((select public.is_editor()));

create policy sources_delete_for_editors
  on public.sources for delete to authenticated
  using ((select public.is_editor()));


-- -----------------------------------------------------------------------------
-- configurations — the editorial objective
-- -----------------------------------------------------------------------------
-- Editors may read and update the single row. They may not insert or delete it:
-- the pipeline assumes id='default' exists, and losing it breaks every stage.
alter table public.configurations enable row level security;

create policy configurations_select_for_editors
  on public.configurations for select to authenticated
  using ((select public.is_editor()));

create policy configurations_update_for_editors
  on public.configurations for update to authenticated
  using ((select public.is_editor()))
  with check ((select public.is_editor()));


-- -----------------------------------------------------------------------------
-- editorial_assets — read + review
-- -----------------------------------------------------------------------------
-- Editors read every asset (including legacy ones, which the UI separates by
-- is_legacy) and may update them for review: approve, reject, edit, feedback.
-- Only service_role inserts, because insertion is what `generate` does and an
-- asset created by hand would have no traceability links.
alter table public.editorial_assets enable row level security;

create policy editorial_assets_select_for_editors
  on public.editorial_assets for select to authenticated
  using ((select public.is_editor()));

create policy editorial_assets_update_for_editors
  on public.editorial_assets for update to authenticated
  using ((select public.is_editor()))
  with check ((select public.is_editor()));


-- -----------------------------------------------------------------------------
-- Grants matching the policies above
-- -----------------------------------------------------------------------------
-- service_role: everything. It bypasses RLS but still needs the privilege bit.
grant select, insert, update, delete on all tables in schema public to service_role;

-- authenticated: read the pipeline...
grant select on
  public.raw_posts,
  public.normalized_posts,
  public.analyzed_posts,
  public.anonymized_posts_current,
  public.generation_requests,
  public.editorial_assets,
  public.traceability_links,
  public.traceability_link_posts,
  public.sources,
  public.configurations,
  public.editors
to authenticated;

-- ...and write only where a policy permits it.
grant insert, update, delete on public.sources             to authenticated;
grant update                 on public.configurations      to authenticated;
grant update                 on public.editorial_assets    to authenticated;
grant insert                 on public.generation_requests to authenticated;

-- Note there is deliberately no grant of INSERT/UPDATE/DELETE on raw_posts,
-- normalized_posts, analyzed_posts, anonymized_posts_current,
-- traceability_links, traceability_link_posts or editors to authenticated.
-- Those are written by the pipeline as service_role, or (for editors) by an
-- administrator out of band.


-- =============================================================================
-- Note on provenance integrity
-- =============================================================================
-- editorial_assets_update_for_editors lets an editor write provenance/llm_used.
-- The check constraint from 0001 still applies, so they cannot set a
-- combination that claims unearned knowledge (e.g. llm_used = true while
-- provenance = 'legacy_unverified'). Locking those two columns to service_role
-- entirely needs a column-level trigger; deferred until the review UI exists
-- and we know whether editors ever legitimately need to correct them.
-- =============================================================================

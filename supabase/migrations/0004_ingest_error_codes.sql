-- =============================================================================
-- 0004_ingest_error_codes.sql — classify provider 4xx responses precisely
-- =============================================================================
--
-- The first live dry run hit a provider 404 for a mis-configured source
-- (GBfoods, whose LinkedIn slug does not resolve). Two problems surfaced:
--
--   1. The 404 was classified as 'server_error', which is retryable, so one bad
--      identifier cost THREE provider requests instead of one. The legacy
--      scraper had the same flaw (tenacity retried every 4xx).
--   2. 'server_error' does not tell an operator that the SOURCE CONFIG is wrong,
--      as opposed to the provider being briefly down.
--
-- Two new codes, both for status = 'failed' (not skips), both non-retryable:
--   source_not_found — provider 404. The identifier does not resolve; a human
--                      must correct sources.rapidapi_identifier.
--   client_error     — any other 4xx. A request/config problem, not transient.
--
-- 0003 is already applied to the cloud project and is never edited. This is a
-- forward migration that widens the existing check constraint.
-- =============================================================================

alter table public.ingest_run_sources
  drop constraint ingest_run_sources_error_code_check;

alter table public.ingest_run_sources
  add constraint ingest_run_sources_error_code_check
  check (error_code in (
    'disabled','no_rapidapi_identifier','locked','stale_lock',
    'auth','auth_aborted','rate_limit','server_error','network',
    'malformed_response','timeout','budget_exhausted',
    'source_not_found','client_error'
  ));

comment on constraint ingest_run_sources_error_code_check on public.ingest_run_sources is
  'source_not_found (provider 404) and client_error (other 4xx) are non-retryable and mean '
  'the source configuration, not the provider, needs attention.';


-- -----------------------------------------------------------------------------
-- Data corrections (idempotent, keyed on name)
-- -----------------------------------------------------------------------------

-- 1. Quarantine GBfoods. Its identifier has never resolved: zero rows in the
--    legacy connector db, an identical 404 in the scraper log, and three wasted
--    requests in the first live validation. Disable it and clear the identifier
--    so a "collect every enabled source" run cannot call it by accident.
--    sources.url is deliberately left as the human reference. Re-enable only
--    after the real LinkedIn company URL has been independently verified.
update public.sources
   set enabled = false,
       rapidapi_identifier = null
 where name = 'GBfoods Italy LinkedIn';

-- 2. European Commission: pin the EXACT provider input proven to work. The 49
--    successfully fetched legacy rows used the trailing-slash form, so use it
--    verbatim. Canonicalisation (dropping the slash) and the live provider path
--    must not be tested at the same time; the slash form is the known-good one.
update public.sources
   set rapidapi_identifier = 'https://www.linkedin.com/company/european-commission/'
 where name = 'European Commission LinkedIn';

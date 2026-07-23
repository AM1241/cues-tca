# Phase 2 completion record — Ingest

The `ingest` Edge Function collects LinkedIn posts per configured source and
upserts them into `raw_posts`, replacing the legacy subprocess → sibling-repo →
HTTP loop. Validated end to end against the cloud project
`bxaovkzemfyxrxbcqask` on 2026-07-23.

## Status

**Complete.** The pipeline's ingest stage is live and proven idempotent. `pg_cron`
is deliberately not enabled (see Known limitations).

## Migrations and deployed function

| | |
|---|---|
| `0003_ingest.sql` | `raw_posts.last_seen_at`; `ingest_runs`, `ingest_run_sources`, `raw_post_content_changes`; per-source concurrency lock; finalizer + reaper RPCs; `rapidapi_identifier` for the four sources |
| `0004_ingest_error_codes.sql` | adds `source_not_found` / `client_error`; repoints the mislabelled source to STAR; pins the EC trailing-slash URL |
| Function `ingest` | **version 4**, ACTIVE, `verify_jwt = false` |

## Authentication boundary

`verify_jwt = false` at the platform edge; `_shared/auth.ts` is the whole gate,
failing closed:

- **editor path** — real user access token, verified via `auth.getUser()`, then
  required in `public.editors` with `role = 'admin'` (admin-only while quota is
  being measured);
- **internal path** — a dedicated secret in the `apikey` header, constant-time
  compared, for cron/backfill;
- the **service-role key is rejected** as a caller credential in both header
  positions; no unverified JWT claim selects a path.

Verified: **24 gateway checks** through the real Edge Runtime, plus **12 cloud
smoke checks**. Every rejection created no run row; the service-role and
publishable keys were both refused as caller credentials.

## Source configuration correction — GBfoods → STAR

The row supplied as "GBfoods Italy" carried `company/gbfoods-italy`, which never
resolved: zero rows in the legacy connector db, an identical 404 in the scraper
log, and three wasted requests in the first live validation. `0004` **repoints
the existing row in place** — same UUID `4417049a-6ddb-4aa9-a3f3-11d590070dde`,
so all `raw_posts` and downstream relationships are preserved:

- name `STAR / GBfoods Italy LinkedIn`, company `STAR / GBfoods Italy`
- url and `rapidapi_identifier` = `https://www.linkedin.com/company/star-spa/`
- enabled. No second row created.

## Provider 404 classification fix

A provider 404 ("the url was not found on Linkedin") was being mapped to the
retryable `server_error`, so one bad identifier cost three requests. Now:

- **404 → `source_not_found`**: non-retryable, exactly one request, persists the
  provider status and message, finalizes source and run as `failed`, and names a
  config fault rather than an outage;
- other **4xx → `client_error`**: non-retryable. Only 5xx, network and timeout
  retry.

## Newest-first ordering — `sort_by=recent`

Every `/get-company-posts` request sends `linkedin_url`, `sort_by=recent`,
`start`. The lookback stop rule ("stop when a whole page has no in-window posts")
is only sound under newest-first ordering, so it is pinned explicitly rather than
relying on the provider default. An offline test asserts `sort_by=recent` on
every page request. The mid-page early-exit optimisation is intentionally
deferred until strictly newest-first behaviour is validated live.

## Live validation

All recorded/reconciled provider_requests comparisons matched the RapidAPI
dashboard delta.

| run | source | dry_run | provider_requests | outcome |
|---|---|---|---|---|
| GBfoods dry run | GBfoods (broken) | true | 3 | HTTP 404, persisted `error_code = server_error` (retryable — 3 requests) |
| EC dry run | European Commission | true | 2 | 98 fetched, 97 out-of-window, 1 eligible, 0 written |
| `7044ff8d…` first real | European Commission | false | 2 | **posts_inserted = 1** |
| `4d4646e3…` second real | European Commission | false | 2 | **posts_inserted = 0**, metadata_refreshed = 1, content_changed = 0 |

The GBfoods dry run happened **before** the 404-classification fix, so it
persisted the 404 as the retryable `server_error` and cost three requests. That
run is exactly what **exposed** the misclassification. The subsequent fix
(`0004`, function v4) makes future 404 responses `source_not_found`,
**non-retryable**, at **one** provider request — but the historical row remains
`server_error` and is not rewritten.

**Idempotency proof.** The first real run inserted the single eligible post; the
second identical run inserted zero and re-saw the same post. Two independent
pieces of evidence, neither of which re-derives a value from its own definition:

- **Metadata refresh:** the post's `last_seen_at` moved forward to the second
  run's window while `collected_at` (first sighting) stayed put — verifiable as
  `last_seen_at > collected_at`, aligned to the second run's
  `started_at`/`finished_at`.
- **Text immutability:** `posts_content_changed = 0` on both runs and
  `raw_post_content_changes = 0` cloud-wide, so no observed-text divergence was
  recorded; the upsert path that guarantees this (metadata-only update on an
  existing row, changed text parked rather than applied) is covered by the
  offline upsert / content-change tests. Immutability is asserted from these,
  not from recomputing `md5(post_text)` — that column is generated as
  `md5(post_text)`, so comparing it to `md5(post_text)` is circular and proves
  nothing.

## Final cloud row counts

| metric | value |
|---|---|
| `raw_posts` | 134 (133 legacy + 1 ingested) |
| European Commission posts | 50 |
| pipeline-created (`legacy_id is null`) | 1 |
| `raw_post_content_changes` | 0 |
| duplicate `external_post_id` | 0 rows |
| sources | 4 |

## Known limitations

- **Cron not enabled.** Deliberate. Nightly cadence must come from measured usage
  against the confirmed RapidAPI plan, not an assumption. The internal-secret
  path the cron job will use is built and tested; only the schedule is pending.
- **Pagination contract not authoritatively confirmed.** Offset paging (`start =
  page*50`) is proven live (start=0 → start=50 returned 98 distinct posts). The
  authoritative RapidAPI Playground is login-gated and could not be read;
  secondary docs conflict (one lists a `pagination_token`, another a numeric
  `page`). Offset paging is kept and the repeat-id stop guards a provider that
  ignores `start`. Revisit only with the exact Playground field names.
- **Mid-page early exit not implemented** — waits on live validation that results
  are strictly newest-first with no pinned/out-of-order posts.
- **Fratelli and MASAF identifiers are canonicalized** (no trailing slash / no
  `/posts` suffix), not the exact proven forms. Pin the proven form before any
  live call to either, as was done for EC.
- **7 legacy `analyzed_posts` rows have `overall_relevance = 0`** with non-zero
  per-theme scores — a Phase 3 data-quality investigation (flagged in `0001`).
- **Storage must be re-enabled locally** before the optional Phase 3 OpenAI Batch
  path (see `supabase/config.toml`).

## Commits

| Hash | Description |
|---|---|
| `5103bc2` | Phase 2: ingest schema, Edge Function and offline tests |
| `2d2f423` | exact attempt counts, budget status, malformed counts |
| `68fa401` | real auth boundary, aborted-source audit, gateway tests |
| `dbf7f8f` | classify provider 4xx precisely; pin EC proven URL |
| `35ea2f1` | repoint the mislabelled source to STAR / GBfoods Italy |
| `b43e5bf` | pin newest-first ordering (`sort_by=recent`) |

## Test coverage

81 offline tests (unit + handler against the local stack, scripted provider — no
RapidAPI), `deno check` clean, plus the Phase 1 and Phase 2 SQL suites. Provider
integration proven live by the runs above. Validation scripts:
`scripts/cloud_smoke.mjs`, `scripts/live_dryrun.mjs`, `scripts/live_realrun.mjs`
(all read secrets from the environment).

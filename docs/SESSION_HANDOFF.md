# Session handoff — CUES Editorial Cloud

Last updated: 2026-07-23. Read this first, then `MIGRATION_PLAN.md` and the
`docs/phase-*-completion.md` records. This file is the single "where are we"
pointer between working sessions.

## One-paragraph state

Phases 0, 1 and 2 are **complete and live on the cloud**. Phase 3 (Scoring) is
**designed (3A) and its database layer is built and fully tested locally (3B)**,
but **3B is not applied to the cloud** and the `score-worker` is **not built**.
No OpenAI call has ever been made. Cron is not enabled anywhere. The legacy
system (`../cues-tca-editorial-agent` Docker container + volume) is untouched and
remains authoritative until Phase 7.

## Cloud vs local — exact state

| | Cloud (`bxaovkzemfyxrxbcqask`, eu-west-1, PG 17.6) | Local stack |
|---|---|---|
| Migrations | **0001–0004 applied** | 0001–0005 apply cleanly |
| `0005_scoring.sql` | **NOT applied** | applied + tested |
| Data | 134 raw_posts (133 legacy + 1 EC), 133 analyzed (all simulated), 15 assets, 89/469 traceability, 4 sources | reproduced via loader (133 raw; EC post is cloud-only) |
| `ingest` function | **deployed v4, ACTIVE, verify_jwt=false** | served locally for tests |
| Secrets | `RAPIDAPI_KEY`, `INGEST_INTERNAL_SECRET`, `ALLOWED_ORIGINS`, `OPENAI_API_KEY` set | `.env.test` (gitignored) |
| Extensions | pgmq 1.5.1 + pg_cron 1.6.4 **available, not installed** | pgmq verified |

**Delta boundary** (legacy → cloud seed): `2026-07-22T02:17:11.788315+00:00`. The
cloud data is a **dev/test seed**, not the production cutover — see
`docs/cloud-migration-runbook.md` (final cutover needs a write freeze or delta
migration; the truncate-loader is single-use).

## What each phase delivered

- **Phase 0** — scaffold: Supabase CLI (devDependency), Vite+React+TS+Tailwind,
  `netlify.toml`, git, cloud link. Local `analytics`/`storage`/`studio` disabled
  in `config.toml` (host healthcheck race); **Storage must be re-enabled before
  any Phase-3 OpenAI Batch work**.
- **Phase 1** (`docs/phase-1-completion.md`) — 9 legacy tables → Postgres with
  uuid PKs, `timestamptz`, `jsonb`, FKs; `editors` allowlist + RLS + grants on
  every table; legacy data loaded (identity = `(source_id, external_post_id)`,
  the LinkedIn URN — not content hash). First editor bootstrapped as admin.
- **Phase 2** (`docs/phase-2-completion.md`) — `ingest` Edge Function
  (`verify_jwt=false`; internal-secret path for cron, admin-editor path for
  users; service-role key rejected as a caller credential). `0003` (queue/obs
  tables, concurrency lock, content-change capture) + `0004` (4xx classification;
  **STAR/GBfoods repoint**; EC pinned to the trailing-slash proven URL). Proven
  idempotent live on European Commission (run 1 inserted 1, run 2 inserted 0).
  81 offline Deno tests + 24 gateway checks. `sort_by=recent` pins newest-first.
- **Phase 3A** (design, in-conversation) — audit found **all 133 migrated
  analyses are simulated** (`reason='Simulated LLM semantic scoring'`); the EC
  post is unscored. Recommended: pgmq queue + `score-worker`, OpenAI **Responses
  API** structured outputs, synchronous (Batch deferred), server-derived overall.
- **Phase 3B** (this session — the commit this handoff accompanies) —
  `0005_scoring.sql`, **local only, not on cloud**:
  - `scoring_requests` = immutable definition of one scoring run (prompt, config
    snapshot, pinned model, aggregation); only `status` transitions.
  - `scoring_results` = **append-only** history (UPDATE/DELETE blocked by
    triggers; SELECT-only grants; TRUNCATE revoked). `analyzed_posts` stays the
    current projection via `current_result_id`.
  - `scoring_job_state` (business retry: `failure_count`, server-side backoff
    30s→120s→dead-letter) + `scoring_dead_letter` (one record per job).
  - pgmq `scoring_jobs` queue; enqueue trigger fires only for pipeline posts and
    only under an **active production request**.
  - 133 simulated analyses imported as `provenance_status='legacy_unknown'`,
    `scoring_request_id=null`, **exact** historical `included_in_generation`.
  - RPCs: `create/activate/close_scoring_request`, `open_production_scoring_request`,
    `enqueue_scoring_job`, `backfill_scoring_for_request`, `enqueue_reevaluation`,
    `complete_scoring_job` (definition comes from the request; worker cannot
    override model/prompt/config/aggregation/source), `record_scoring_failure`,
    `dead_letter_scoring_job`, `revive_scoring_job`, `set_current_scoring_result`
    (promote/rollback, copies stored projection incl. `included_in_generation`),
    `import_legacy_analyses`.
  - The migration creates **no production request and no jobs** — the first EC
    job is created later under an approved request.
  - Verified: `scripts/verify_scoring.sql` (37 assertions, 0 failures), plus
    Phase 1/2 regressions still green, application counts unchanged.

## Verify locally (any session)

```bash
npx supabase db reset            # applies 0001–0005 (re-run if a container-restart flake trips it)
# then load the legacy seed (see scripts/README.md: snapshot -> build loader -> psql)
psql "$DB_URL" -f scripts/verify_rls.sql       # Phase 1
psql "$DB_URL" -f scripts/verify_ingest.sql    # Phase 2
psql "$DB_URL" -f scripts/verify_scoring.sql   # Phase 3B  (expect 37 RESULT, 0 BAD)
# Deno ingest tests:
docker run --rm -v "$PWD/supabase/functions:/app" -w /app denoland/deno:alpine-2.5.2 \
  deno test --allow-env --allow-net=jsr.io ingest/__tests__/
```

## Future work (in order)

1. **Review Phase 3B → apply `0005` to cloud.** `npx supabase db push` (needs the
   DB password; run it yourself). Applying it creates **133** legacy
   `scoring_results`, links 133 analyzed rows, **0 jobs**, **no** request. Then
   `supabase gen types typescript --local > frontend/src/lib/database.types.ts`.
2. **Phase 3C — `score-worker` Edge Function.** OpenAI **Responses API**
   (`/v1/responses`, `text.format` strict json_schema, `store:false`, dynamic
   schema from the request's `config_snapshot`). Internal-secret auth (reuse
   `_shared/auth.ts`). Flow: reap → `pgmq.read` → build prompt → call OpenAI →
   validate → call `complete_scoring_job` / `record_scoring_failure` /
   `dead_letter_scoring_job`. **No silent fallback.** Handle refusal / incomplete
   (max tokens) / content-filter / empty / 429 / 5xx / timeout / 4xx per the 3A
   addendum §9. Offline tests with a scripted OpenAI, mirroring the ingest
   harness.
3. **Phase 3E** — one controlled cloud scoring call: **EC post only** (~$0.0003).
4. **Phase 3F** — score a ~24-post sample (incl. the 7 historically inconsistent
   rows), review against a written rubric, then `open_production_scoring_request`
   + backfill. **Promotion gate** before making real scores current.
5. **Phase 3G** — enable `pg_cron` drain, only after cost + reliability measured.
6. **Phases 4–7** (`MIGRATION_PLAN.md`): anonymise + pgvector clustering;
   generation; frontend; review/export/deploy + **final cutover**.

## Open product decisions (defaults chosen, need confirmation)

- **Overall aggregation**: `max_theme_v1` (server-derived max) — evaluation
  default, not final policy. Replaceable without rewriting history.
- **OpenAI model**: not chosen. Must be a **pinned snapshot** confirmed on the
  account, selected via the 3F evaluation (not by price). Structured outputs
  confirmed on gpt-4o-mini / gpt-4o-2024-08-06+ incl. gpt-5.6; cheapest official
  tiers gpt-5.4-nano ($0.20/$1.25), gpt-5.4-mini ($0.75/$4.50). Cost is trivial
  (~cents/mo); Batch API **deferred**.
- **API surface**: Responses API (per Phase 3B decision).
- **`included_in_generation`**: stored derived compatibility field now; a
  separate manual editorial-selection field comes with the review phase.

## Hard constraints / gotchas

- Never enable cron without explicit approval. Never make a `dry_run=false` or
  live OpenAI call without explicit approval.
- Service-role / secret keys never reach the frontend; only URL + publishable key.
- `load_legacy.sql` truncates — safe only on an empty target; destructive once a
  pipeline has written real data.
- Fratelli/MASAF `rapidapi_identifier`s are canonicalized (not the exact proven
  forms) — pin the proven form before any live call to those, as done for EC.
- `db reset` occasionally trips a container-restart timeout; just re-run.

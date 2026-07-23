# Migration & optimisation plan

Moving `cues-tca-editorial-agent` (FastAPI + SQLite + Docker, no auth, no UI) to
Supabase + Netlify, and fixing the things that make the current system expensive to operate.

Target: an editor opens a URL, logs in, sees the collected posts and their scores, adjusts
the editorial objective, presses a button, reviews the generated post, approves it, exports
it. No terminal, no Docker, no manually shuttling JSONL files to a provider.

## Why Supabase can carry all of this

The legacy pipeline is regex, string assembly and LLM HTTP calls. `requirements.runtime.txt`
is nine packages, none of them ML — `numpy`, `spacy` and `sentence-transformers` are listed
in `requirements.txt` but never imported at runtime. So nothing forces Python, and Deno
Edge Functions can run every stage.

The two constraints that do bite, and the answers:

| Constraint | Impact | Answer |
|---|---|---|
| Edge Function wall clock ~400s | Scoring 133 posts in one invocation would blow it | Work queue (`pgmq`) drained in chunks by a cron-triggered worker |
| Edge Function CPU time ~2s | Irrelevant — the work is awaiting `fetch`, not computing | — |
| No long-lived process | No APScheduler | `pg_cron` for nightly ingest and queue draining |
| No local filesystem | Batch JSONL and exports have nowhere to live | Supabase Storage |

At 133 posts, 4 sources and ~10 users, this sits inside the Supabase and Netlify free tiers;
the only real cost is LLM tokens.

## Architecture

```
Netlify (static)                     Supabase
┌──────────────────┐                 ┌─────────────────────────────────────┐
│ Vite React SPA   │  supabase-js    │ Auth (magic link) ── editors table  │
│  Sources         │ ───────────────>│ Postgres + RLS + pgvector           │
│  Posts & scores  │   anon key      │   sources, raw_posts,               │
│  Objective       │                 │   analyzed_posts,                   │
│  Generate        │  invoke()       │   anonymized_posts_current,         │
│  Review/Approve  │ ───────────────>│   editorial_assets, traceability    │
│  Export          │                 │ Edge Functions (Deno/TS)            │
└──────────────────┘                 │   ingest score anonymize            │
                                     │   cluster generate export           │
                                     │ pgmq queue + pg_cron                │
                                     │ Storage: batches, exports           │
                                     └─────────────────────────────────────┘
                                          │ RapidAPI LinkedIn, OpenAI
```

Rule: the browser never holds a provider key. All LLM and RapidAPI calls happen in Edge
Functions using secrets set with `supabase secrets set`.

## What changes, and why

Beyond the lift-and-shift, these are the actual improvements. Each maps to a phase below.

1. **The manual batch step disappears.** Today an operator runs `batch/build`, takes the
   JSONL to the provider by hand, and posts back a `results_path`. Replaced by a queue: new
   posts are enqueued on insert, a cron-driven worker drains them. Optionally the OpenAI
   Batch API is used for cost (50% cheaper, 24h) with cron polling the batch status — still
   zero human steps.
2. **Scoring returns per-theme scores again.** The live batch prompt asks for a bare integer,
   so `apply_scores` writes `{theme: 0.0}` for all themes — which starves clustering, which
   buckets posts by highest per-theme score. The richer prompt already exists in the dead
   `llm_batch_scoring_service.py`; port that one, with a JSON schema response format.
3. **Real clustering.** pgvector embeddings + cosine similarity instead of "assign to the
   theme with the highest score". Same embeddings also give semantic dedup, which the
   current URL-equality check misses.
4. **No silent fallback.** `_call_real_llm` swallows every exception and returns hardcoded
   editorial copy. Failures become explicit errors with a `llm_used: false` flag surfaced in
   the UI, never a canned post that reads like a real one.
5. **Structured LLM output.** Titles and hashtags are currently regex-scraped out of markdown.
   Use JSON schema output so the asset fields are typed at the source.
6. **Anonymisation gets an entity pass.** Today the replacement map is built from source
   names only — a company mentioned in the body but not the source name survives. Add an LLM
   entity-extraction step, keep the deterministic replacement and the `replacements` audit
   list.
7. **Review and export actually exist.** The columns are there; nothing writes them. Every
   stored asset is `status='draft'`. This is the missing half of the product.
8. **Auth and RLS.** There is currently no authentication and `allow_origins=["*"]`. On a
   public Netlify URL that is not acceptable.

## Phases

Each phase ends in something demonstrable. Don't start the next until the check passes.

### Phase 0 — Foundation

- `supabase init`, link a cloud project, `npm create vite@latest frontend -- --template react-ts`,
  Tailwind, `netlify.toml`, `.gitignore`, `git init` (the legacy repo was never under version control).
- Commit `CLAUDE.md`, `MIGRATION_PLAN.md`, `docs/`.
- **Check:** `supabase start` and `npm run dev` both come up clean.

### Phase 1 — Schema, auth, data migration ✅ COMPLETE

Applied to the cloud project 2026-07-22. Full record in `docs/phase-1-completion.md`.

- [x] Migration `0001_schema.sql`: port the nine tables with real types — `timestamptz` not naive
  datetimes, `uuid` PKs, `jsonb`, FK constraints, indexes on `raw_posts(source_id, published_at)`
  and `analyzed_posts(overall_relevance)`.
- [x] Fix `raw_posts`: surrogate `uuid` PK. **Revised during implementation** — the unique key is
  `(source_id, external_post_id)` (the LinkedIn activity URN), *not* `(source_id, content_hash)`.
  Hashing the text would have re-created the very collision it was meant to fix: a company
  reposting identical copy at a new URL is a distinct post. `content_hash` is indexed, not unique.
  Added `updated_at` triggers.
- [x] Drop `clusters` and `analyzed_posts_backup_before_mock_llm`. Clustering is stateless; the
  backup table was a one-off.
- [x] Migration `0002_auth_rls.sql`: `editors` table keyed to `auth.users`, RLS on every table
  (`authenticated` + present in `editors`), service-role-only write paths for pipeline tables.
  **Also required, and not anticipated here:** explicit table and column grants. This Postgres
  grants no DML by default, so policies alone are unreachable and `service_role` cannot write;
  and `authenticated` held `TRUNCATE` on every table, which RLS does not filter.
- [x] One-shot script to load the legacy dump: 133 posts, 4 sources, 30 anonymised, 15 assets,
  89 traceability links. Migrate `configurations` as a single row.
- [x] **Check:** row counts match `docs/legacy-system.md`; an anon-key client is denied on every
  table; a logged-in allowlisted user can read posts. — all verified locally and in the cloud.

> **The cloud data is a development/test seed, not the production cutover.** The legacy
> application remains authoritative and its Docker volume untouched until Phase 7. The loader
> truncates before loading and is therefore single-use: re-running it after Phase 2 starts
> ingesting would destroy pipeline output and reviewed editorial work. Final cutover requires a
> write freeze or a delta migration — see *Final cutover* in `docs/cloud-migration-runbook.md`.
> Delta boundary: **2026-07-22T02:17:11.788315+00:00**.

### Phase 2 — Ingest ✅ COMPLETE

Validated against the cloud on 2026-07-23. Full record in `docs/phase-2-completion.md`.

- [x] Edge Function `ingest`: calls RapidAPI LinkedIn directly per configured source, upserts
  into `raw_posts`, honours `lookback_days`. The `subprocess` → sibling-repo → HTTP-back-to-itself
  loop is gone. **Identity is `(source_id, external_post_id)`, not the content hash** (see Phase 1).
- [x] Move `connector_config.json` into the `sources` table; add `rapidapi_identifier` and
  `lookback_days` columns (migration `0003_ingest.sql`).
- [x] Manual "Collect now" path: admin-only, JWT + `editors` allowlist, internal-secret path for
  cron. `0003` also adds run/observability tables, a per-source concurrency lock, and
  content-change capture; `0004` adds precise 4xx classification.
- [x] **Check:** a live run inserts new rows and a second identical run inserts nothing —
  proven on European Commission (run 1 inserted 1, run 2 inserted 0, metadata refreshed, text
  never overwritten).

> **`pg_cron` nightly trigger is intentionally NOT enabled yet.** Cadence must be set from
> measured provider usage against the confirmed RapidAPI plan, not assumed. The internal-secret
> path the cron job will use is built and tested; enabling the schedule is a deliberate later
> step. See the completion doc's "Known limitations".

### Phase 3 — Scoring

- [x] **3A — design** (in-conversation). Audit found all 133 migrated analyses are
  simulated (`reason='Simulated LLM semantic scoring'`); the EC post is unscored.
  Decided: `pgmq` queue + `score-worker`, OpenAI Responses API structured outputs,
  synchronous (Batch deferred), server-derived overall score.
- [x] **3B — database layer**, migration `0005_scoring.sql`. Built and tested locally,
  then **applied to the cloud project on 2026-07-23** (`supabase db push`; confirmed via
  `supabase migration list`, local and remote both show 0005). `frontend/src/lib/database.types.ts`
  regenerated against the cloud schema and committed.
  - `scoring_requests` (immutable run definition; only `status` transitions) +
    `scoring_results` (append-only history — UPDATE/DELETE blocked by trigger, TRUNCATE
    revoked; `analyzed_posts.current_result_id` holds the current projection).
  - `scoring_job_state` (business retry, 30s→120s→dead-letter backoff) +
    `scoring_dead_letter`.
  - pgmq `scoring_jobs` queue; enqueue trigger fires only for pipeline posts under an
    *active production* request.
  - 133 simulated analyses imported as `provenance_status='legacy_unknown'`,
    `scoring_request_id=null`.
  - RPCs: `create/activate/close_scoring_request`, `open_production_scoring_request`,
    `enqueue_scoring_job`, `backfill_scoring_for_request`, `enqueue_reevaluation`,
    `complete_scoring_job` (definition comes from the request — worker cannot override
    model/prompt/config/aggregation/source), `record_scoring_failure`,
    `dead_letter_scoring_job`, `revive_scoring_job`, `set_current_scoring_result`
    (promote/rollback), `import_legacy_analyses`.
  - The migration creates **no production request and no jobs** on its own — cloud state
    after the push is 133 legacy `scoring_results` linked, 0 jobs, no request.
  - Verified: `scripts/verify_scoring.sql` (37 assertions, 0 failures); Phase 1/2
    regressions still green.
- [ ] **3C — `score-worker` Edge Function.** OpenAI Responses API (`/v1/responses`,
  `text.format` strict json_schema, `store:false`, schema built dynamically from the
  request's `config_snapshot`). Internal-secret auth (reuse `_shared/auth.ts`). Flow:
  reap → `pgmq.read` → build prompt → call OpenAI → validate → `complete_scoring_job` /
  `record_scoring_failure` / `dead_letter_scoring_job`. No silent fallback — handle
  refusal / incomplete (max tokens) / content-filter / empty / 429 / 5xx / timeout / 4xx.
  Offline tests with a scripted OpenAI, mirroring the `ingest` harness.
- [ ] **3D — model + prompt.** Port the richer per-theme prompt from the dead
  `llm_batch_scoring_service.py` (not the live integer-only one). Pin a specific OpenAI
  model snapshot (not yet chosen — see Open product decisions below).
- [ ] **3E — one controlled cloud call**, EC post only (~$0.0003), explicit approval
  required before it runs.
- [ ] **3F — sample evaluation.** Score a ~24-post sample (incl. the 7 historically
  inconsistent rows) against a written rubric, then `open_production_scoring_request` +
  backfill. Promotion gate before real scores become current.
- [ ] **3G — enable `pg_cron` drain**, only after cost + reliability are measured from 3E/3F.
- **Check:** re-scoring all currently available raw posts completes unattended and every
  row has non-zero per-theme scores. (134 at the Phase 2 completion snapshot — 133 legacy
  plus the one European Commission post ingested during Phase 2 validation.)

### Phase 4 — Anonymise & cluster

- Edge Function `anonymize`: LLM entity extraction, then the legacy deterministic replacement
  (port `anonymization_service.py` closely — the public-body preservation list and the
  `replacements` audit trail are correct and worth keeping). Upsert into
  `anonymized_posts_current`, preserving overwrite-only semantics and the config snapshot.
- Enable `pgvector`; embed each anonymised post; cluster by cosine similarity; label clusters
  with one LLM call each. Replace `objective_clustering_service.py` wholesale.
- **Check:** clusters are semantically coherent on the real 133 posts and no longer collapse
  into the single "Objective Context" fallback.

### Phase 5 — Generation

- Edge Function `generate`: port the prompt builder and the four output formats
  (`post`, `carousel`, `post+carousel`, `newsletter`) close to verbatim — this is the best
  code in the legacy system. Read from `anonymized_posts_current` for the requested window.
- Structured JSON output for title / body / slides / hashtags. Write `editorial_assets` +
  `traceability_links` in one transaction.
- No simulated fallback. On LLM failure, fail the request and surface it.
- **Check:** output quality matches or beats the stored legacy assets on the same window.

### Phase 6 — Frontend

Routes: **Sources** (CRUD, enable/disable, collect now) · **Posts** (table with scores,
reasons, filters) · **Objective** (themes, voice, threshold, aliases — the config row) ·
**Generate** (period, format, instructions; live job status) · **Review** (asset with its
traceability panel, edit, approve, reject, request regeneration) · **Export**.

- `supabase-js` with the anon key; generated types from `supabase gen types typescript`.
- Magic-link login, allowlist enforced by RLS.
- Realtime subscription on job status so long pipeline runs report progress.
- **Check:** the full pipeline is drivable end to end without a terminal.

### Phase 7 — Review, export, deploy

- Review is the last unbuilt stage: write `status`, `approved_by`, `approval_timestamp`,
  `approval_notes`, `feedback_provided`; regeneration re-runs `generate` with the feedback
  appended to the prompt and links the new asset to the old one.
- Export: markdown and JSON client-side; DOCX via Edge Function into Storage with a signed URL.
  Traceability export ships the source-post mapping alongside.
- Netlify: connect the GitHub repo, `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in build
  env, SPA redirect rule. Deploy previews on PRs.
- **Check:** an editor completes collect → score → generate → approve → export on the
  production URL.

## Sequencing note

Phases 1–5 can be built and verified against the local stack before anything is deployed.
Phase 6 needs Phase 1 (types and RLS) but not Phases 3–5 — it can start in parallel against
the migrated data.

## Before starting

- **Rotate the OpenAI key.** The legacy `.env` holds a live one. Set the new key with
  `supabase secrets set`, never in the frontend or Netlify env.
- Take the legacy dump (`docs/legacy-system.md` has the command) and keep the old Docker
  container running until Phase 7 passes.

## Open questions

- RapidAPI: which endpoint/provider does `../linkedin_rapidapi_scraper` actually call? Needed
  for Phase 2 — that repo has to be read before the ingest function can be written.
- Do the 15 stored `editorial_assets` need to survive, given some are likely simulated
  fallback output rather than real generations? Migrating them with an `is_legacy` flag is
  the safe default.
- Multi-tenant later, or CUES-only forever? Affects whether `sources` and `configurations`
  get an `org_id` in Phase 1. Adding it now is cheap; retrofitting is not.

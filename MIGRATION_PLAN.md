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
| Edge Function wall clock ~400s | Scoring 133 posts in one invocation would blow it | Work queue (`pgmq`) drained in chunks by an on-demand worker |
| Edge Function CPU time ~2s | Irrelevant — the work is awaiting `fetch`, not computing | — |
| No long-lived process | No APScheduler | Human-triggered invocation (a button per stage); the queue holds state between drains |
| No local filesystem | Batch JSONL and exports have nowhere to live | Supabase Storage |

At 133 posts, 4 sources and ~10 users, this sits inside the Supabase and Netlify free tiers;
the only real cost is LLM tokens. Ingest, scoring and the queue drain are triggered on demand
(a button in the UI, or the internal-secret path) rather than by a scheduler — a batch tool
used by ~10 people is driven by people, and on-demand triggering avoids depending on any
scheduler extension or on a project staying awake. Unattended automation, if wanted later, is
an optional add-on (see *Optional automation* below), not a dependency of the product.

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
                                     │ pgmq queue (on-demand drain)        │
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
   posts are enqueued on insert, and an on-demand worker (invoked from the UI or the
   internal-secret path) drains them in chunks. Optionally the OpenAI Batch API is used for
   cost (50% cheaper, 24h), polled by re-invoking the worker — still one button, no JSONL
   shuttling.
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
- [x] Manual "Collect now" path: admin-only, JWT + `editors` allowlist, plus an internal-secret
  path for programmatic (non-UI) triggering. `0003` also adds run/observability tables, a
  per-source concurrency lock, and content-change capture; `0004` adds precise 4xx classification.
- [x] **Check:** a live run inserts new rows and a second identical run inserts nothing —
  proven on European Commission (run 1 inserted 1, run 2 inserted 0, metadata refreshed, text
  never overwritten).

> **Ingest is triggered on demand, not on a schedule.** An editor presses "Collect now"; the
> internal-secret path also allows programmatic triggering if unattended runs are ever wanted
> (see *Optional automation*). This keeps the tool inside the free tier and independent of any
> scheduler extension or of the project staying awake. See the completion doc's "Known
> limitations".

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
- [x] **3C — `score-worker` Edge Function. Deployed to cloud and hardened (2026-07-24, session 6).**
  Migrations `0006`/`0008` plus `0009_scoring_worker_lease.sql` and
  `0010_scoring_prompt_snapshot.sql` applied to cloud; `score-worker` deployed
  (`verify_jwt=false`, internal-secret auth). `deno check` clean; offline suite **18/18**;
  `verify_scoring.sql` all green against cloud; a 2-post live smoke test scored correctly
  with the pinned snapshot. Blockers resolved: OpenAI error disposition (`0008`);
  atomic claim/lease via `processing_token` — `read_scoring_jobs` stamps a per-claim token,
  `complete/record_scoring_job` return `'superseded'` for a stale token instead of raising,
  so a losing worker never aborts the batch (#1/#2); immutable prompt snapshot — the prompt
  template is stored on the request (`0010`, `public.scoring_prompt_template()`) and the
  worker renders from it, not a hardcoded constant (#3); DB-completion failures return
  `infra_error` and do **not** burn a business retry (#5); extended `verify_scoring.sql`
  assertions (#6); per-test request isolation (#7); comment fix (#9).
- [x] **3C (continued) — request-wide circuit-break hardening, deployed to cloud
  (2026-07-24, session 7).** Migrations `0011_scoring_request_circuit_break.sql`,
  `0012_scoring_circuit_break_lock_order.sql`, `0013_scoring_enqueue_lock_order.sql`
  applied to cloud; `score-worker` redeployed. `0011`: a request-wide client error
  (400/401/403/404/422) now dead-letters every pending/processing sibling job under the
  same request via `cancel_scoring_request_siblings`, not just the triggering job —
  `service_role` cannot call that function directly, only `record_scoring_failure` can.
  `0012`/`0013`: `complete_scoring_job`, `record_scoring_failure`, and `enqueue_scoring_job`
  all lock the `scoring_requests` row first, before any job row — closing a real race where
  a job could be enqueued, or left non-terminal, around the exact moment a circuit-break
  closes the request. Deno suite: 32 steps passed. Two real two-session RPC concurrency
  probes (not simulated) confirmed both lock orderings serialize correctly with no
  deadlock and no orphaned non-terminal job. `verify_scoring.sql` passed seedless
  (`require_legacy_seed=0`, exit 0, explicit rollback). A controlled cloud smoke test
  scored one real job end to end (`failure_count=0`, exactly one result, a second drain
  invocation made zero further OpenAI calls), then closed its evaluation request; queue
  and active-request count returned to empty/zero. No cron, backfill, or production
  scoring request was created. **Phase 3 core functionality is complete as of this
  session** — see `docs/SESSION_HANDOFF.md` for full session detail.
- [x] **3D — model + prompt.** Richer per-theme rubric prompt ported and, as of
  `0010`, stored on the request itself (`public.scoring_prompt_template()`), not
  hardcoded. Model pinned to the dated snapshot **`gpt-5.4-nano-2026-03-17`**
  (400k context / 128k max output; structured outputs via the Responses API
  confirmed). Chosen pragmatically from the 3E validation, not a full rubric review —
  the optional follow-up evaluation below may still revise it before scoring at
  production scale.
- [x] **3E — controlled cloud calls done (2026-07-24, sessions 6 and 7).** Three rounds
  against the deployed worker on evaluation requests (non-production, nothing promoted to
  `current_result_id`): a 3-post spread (92 sustainability / 85 food+tradition / 0
  World-Cup noise), a 2-post smoke test after the session-6 hardening, and a 1-post smoke
  test after the session-7 circuit-break hardening. Total spend well under $0.01.
  `llm_used=true`, structured outputs + strict schema + our parser all confirmed live.

**Completed Phase 3 core work:** schema (3B), worker deployment + lease/prompt-snapshot
hardening (3C), request-wide circuit-break + full lock ordering (3C continued), model/prompt
pinning (3D), and controlled live validation (3E) — all applied to cloud, all verified.
Migrations **0001–0013** are on cloud; `score-worker` is deployed and hardened;
local verification (Deno suite, seedless SQL assertions, two-session concurrency probes)
and a controlled real-OpenAI cloud smoke test all passed.

**Optional follow-up validation (non-blocking, not required for Phase 3 to be considered
done):**

- [ ] **Strict 133-row legacy regression** — needs the 133-post legacy seed via
  `../cues-tca-editorial-agent`, not present on every machine. The scoring/circuit-break
  changes don't touch `ingest` or the legacy data path; this is a coverage nice-to-have,
  not an indication anything is broken.
- [ ] **Sample evaluation against a written rubric** — score a ~24-post sample (incl. the
  7 historically inconsistent rows), then `open_production_scoring_request` + backfill.
  This is the gate before real scores are promoted via `set_current_scoring_result` and
  become what editors see — a product/quality decision, not a Phase 3 implementation gap.
- [ ] **Repeat-drain loop at scale** — confirm the worker can be re-invoked until the queue
  is empty across many posts without exceeding wall-clock, and that cost/reliability hold
  up. Triggering stays on-demand (button / internal-secret path).

Both of the last two require explicit go-ahead on OpenAI spend before running.

**Phase 4 is complete** — see `docs/PHASE4_COMPLETION.md`. (`docs/PHASE4_KICKOFF.md`
remains as the historical record of how Phase 4 was started.)

### Phase 4 — Anonymise & cluster ✅ IMPLEMENTED, DEPLOYED, SMOKE-VERIFIED

> The section immediately below is the original architectural sketch, written
> before Phase 3 existed in its current form, kept for history. The confirmed
> spec was `docs/PHASE4_REQUIREMENTS.md`; the confirmed closure record is
> `docs/PHASE4_COMPLETION.md` — read that for the actual implementation shape,
> verification results, and the intentionally deferred real-content validation.

- [x] **4A — schema + Edge Functions**, migrations `0014_anonymize_schema.sql` /
  `0015_clustering.sql`. Built, tested, and applied to cloud
  (`supabase db push`; confirmed via `supabase migration list`, local and
  remote both show 0014/0015). `anonymize-worker` and `cluster` Edge
  Functions deployed, `ACTIVE`, v1, `verify_jwt=false`.
  - `anonymize_results` (append-only, immutability-trigger-enforced) +
    `anonymized_posts_current.current_result_id` (current projection
    pointer), mirroring the `scoring_results` pattern.
  - `anonymize_results(id, raw_post_id)` composite-unique constraint with
    composite FKs from `post_embeddings`/`clustering_run_posts` — the
    database rejects a `raw_post_id` paired with another post's
    `anonymize_result_id`.
  - `clustering_runs` (immutable run definition, snapshotted config) +
    `clustering_run_posts.embedding_status` (persisted per-post embedding
    audit trail, `pending|embedded|failed`).
  - `complete_clustering_run` computes centroids using only the run's own
    `embedding_model` — never averages embeddings from a different model —
    and hard-fails on any assigned post missing an embedding under that
    model.
  - Fail-loud throughout: no silent fallback on an LLM failure in either
    function.
- [x] **4B — verification.** Local: Deno offline suites (64 steps, 0 failed),
  `scripts/verify_phase4.sql` (exit 0, `ON_ERROR_STOP=1`), `deno check`
  clean, frontend typecheck/build clean, browser check of the run-failure
  UI indicator clean. Cloud: schema push verified object-by-object (8 new
  tables, RLS on all 8, 11 new RPCs, new config columns); both functions
  deployed and confirmed `ACTIVE`; no-op smoke checks against cloud
  (`anonymize-worker` empty-queue `jobs_read=0`; `cluster` zero-eligible
  window `eligible=0, run_id=null`) with zero OpenAI calls and zero new rows
  anywhere. Full detail: `docs/PHASE4_COMPLETION.md`.
- [ ] **4C — real-content validation (intentionally deferred).** Running
  `anonymize-worker` + `cluster` against a small representative set of real
  scored posts, with real OpenAI calls, has **not** been done. This is a
  deliberate product decision, not a blocker — see
  `docs/PHASE4_COMPLETION.md` for the bounded stop conditions the first
  execution should honor.

**Phase 4 core implementation is complete as of this session** (schema,
Edge Functions, local + cloud no-op verification, all applied to cloud). See
`docs/PHASE4_COMPLETION.md` for full detail and `docs/PHASE5_KICKOFF.md` for
how Phase 5 starts without re-auditing this work.

Original architectural sketch (superseded by `PHASE4_REQUIREMENTS.md`, kept for history):

- Edge Function `anonymize`: LLM entity extraction, then the legacy deterministic replacement
  (port `anonymization_service.py` closely — the public-body preservation list and the
  `replacements` audit trail are correct and worth keeping). Upsert into
  `anonymized_posts_current`, preserving overwrite-only semantics and the config snapshot.
- Enable `pgvector`; embed each anonymised post; cluster by cosine similarity; label clusters
  with one LLM call each. Replace `objective_clustering_service.py` wholesale.
- **Check:** clusters are semantically coherent on the real 133 posts and no longer collapse
  into the single "Objective Context" fallback.

### Phase 5 — Generation

> The section below is the original architectural sketch, written before Phase 4
> existed in its current form. It is **not yet a confirmed spec** — see
> `docs/PHASE5_KICKOFF.md` for the starting context and the open product decisions
> that must be resolved (output formats, one-per-cluster vs. one-per-run, review
> workflow explicitly out of initial scope, etc.) before implementation begins.

- Edge Function `generate`: port the prompt builder and the four output formats
  (`post`, `carousel`, `post+carousel`, `newsletter`) close to verbatim — this is the best
  code in the legacy system. Read from `anonymized_posts_current` for the requested window.
- Structured JSON output for title / body / slides / hashtags. Write `editorial_assets` +
  `traceability_links` in one transaction.
- No simulated fallback. On LLM failure, fail the request and surface it.
- **Check:** output quality matches or beats the stored legacy assets on the same window.

### Phase 6 — Frontend — IN PROGRESS

Routes: **Sources** (CRUD, enable/disable, collect now) · **Posts** (table with scores,
reasons, filters) · **Objective** (themes, voice, threshold, aliases — the config row) ·
**Generate** (period, format, instructions; live job status) · **Review** (asset with its
traceability panel, edit, approve, reject, request regeneration) · **Export**.

- `supabase-js` with the publishable key; generated types from `supabase gen types typescript`.
- Login + allowlist enforced by RLS.
- Realtime subscription on job status so long pipeline runs report progress.
- **Check:** the full pipeline is drivable end to end without a terminal.

Progress (2026-07-23, built against the cloud seed data, in parallel with Phase 3):

- [x] Foundation: `react-router-dom` shell with a nav layout; `ErrorBoundary` + a toast
  system + shared `Spinner`/`EmptyState`/`ErrorNotice` primitives. Client typed with the
  generated `Database` generic.
- [x] **Auth gate** — email+password login (`signInWithPassword`), not magic-link. Three
  states: unauthenticated → login; authenticated but not on `public.editors` → explicit
  "awaiting access" screen (RLS returns empty, not an error, so this is surfaced
  deliberately); allowlisted → app. `useAuth` resolves `isEditor` from the allowlist.
- [x] **Posts** — read-only table over `analyzed_posts` joined to `raw_posts`/`sources`:
  per-theme score bars, overall relevance, reason, in-generation badge; filter by source,
  min-relevance, in-generation-only.
- [x] **Sources** — list + enable/disable toggle + create/edit modal. No delete (RLS grants
  none; retire via `enabled=false`). "Collect now" not yet wired (needs `ingest` invoke).
- [x] **Objective** — edits the single `default` config row: themes, voice, threshold,
  anonymisation flags, company aliases. Update only; no insert/delete.
- [x] **Review** — asset list with status + `legacy`/`no-LLM` provenance badges; detail with
  editable title/text/CTA (the 10 RLS-granted columns only), approve/reject writing
  `approved_by = auth.uid()`, and the traceability panel. Regeneration deferred to Phase 7
  (needs `generate`).
- [x] **Export** — client-side Markdown + JSON of an asset (or all in a status filter) with
  traceability; copy + download. DOCX deferred to Phase 7.
- [ ] **Generate** — placeholder only. The form + `generation_requests` insert can be built
  now, but it produces nothing until the `generate` Edge Function (Phase 5) exists.
- [ ] Realtime job-status subscription — deferred until the Phase 3 scoring worker emits
  status.

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

## Optional automation

The product ships fully on-demand: every stage (ingest, score, drain) is triggered by a
button in the UI, and the queue holds work between drains. No scheduler is required, which is
what keeps it inside the free tier and independent of any project-wake behaviour.

If unattended runs are ever wanted, the internal-secret path on `ingest` (and, later, the
worker) is already the hook — an external caller can hit it on whatever cadence is chosen
(e.g. a GitHub Actions cron, or any external HTTP pinger). This stays an optional add-on and
is deliberately **not** a dependency of any phase; do not gate a phase on it, and do not enable
it until cost and reliability have been measured on real runs.

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

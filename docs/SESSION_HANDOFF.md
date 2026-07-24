# Session handoff — CUES Editorial Cloud

Last updated: 2026-07-24 (session 7). Read this first, then `MIGRATION_PLAN.md` and the
`docs/phase-*-completion.md` records. This file is the single "where are we" pointer
between working sessions.

## Plain-language state (read this first)

**Phase 3 core functionality is complete.** Three deployable pieces, all live on cloud:

| Piece | What it does | Deployed? |
|---|---|---|
| `ingest` Edge Function | pulls LinkedIn posts via RapidAPI | **Yes — live, Phase 2 complete** |
| Scoring **database schema** (`scoring_requests`, `scoring_results`, lease, prompt snapshot, request-wide circuit-break, lock ordering) | tables + RPCs the scorer needs | **Yes — migrations 0001–0013 on cloud** |
| `score-worker` Edge Function | calls OpenAI to score posts | **Yes — deployed & hardened (session 7); circuit-break + lock-order race fixed** |

- **Canonical branch:** `phase3c-circuit-break`
- **Deployed code commit:** `e1652c58df1ce5307ef1a131056991a3f46d4047`
- **Cloud migration ledger:** `0001`–`0013` applied (verified via `supabase migration list`)

Session 7 added request-wide circuit-break hardening on top of the session-6 baseline:

- **Request-wide client errors terminalize queued siblings** — a 400/401/403/404/422
  from OpenAI on one job now closes the whole request and dead-letters every sibling job
  still pending/processing under it, instead of leaving them to fail one at a time.
- **Request-first lock ordering** — `complete_scoring_job`, `record_scoring_failure`, and
  (new in `0013`) `enqueue_scoring_job` all lock the `scoring_requests` row first, before
  touching `scoring_job_state`. This closes a real race where a job could be enqueued (or
  left non-terminal) around the exact moment a circuit-break closes the request.
- `cancel_scoring_request_siblings` is `SECURITY DEFINER`-internal only — confirmed
  `service_role` cannot call it directly (no grant exists), it's only reachable from
  inside `record_scoring_failure`'s circuit-break branch.

## Validation performed (session 7)

- Deno offline suite: **32 steps passed**, 0 failed.
- Seedless SQL verification (`scripts/verify_scoring.sql`, `require_legacy_seed=0`):
  **exit 0**, every assertion `OK`, wrapped in savepoints with an explicit final rollback.
- **Two-session real RPC concurrency probes**, run against the local stack with two
  concurrent `psql` sessions coordinated via filesystem markers — both possible lock
  orderings verified directly against the database, not simulated:
  - enqueue-wins: job created, then correctly terminalized as a sibling once the
    circuit-break's `cancel_scoring_request_siblings` runs.
  - circuit-break-wins: request closes first; the blocked enqueue then observes
    `status='closed'` and raises. No job ever created.
  - Neither ordering left a pending/processing job under a closed request; no deadlocks.
- **Controlled cloud smoke test** against the deployed worker, after 0011–0013 were
  pushed to cloud and `score-worker` was redeployed:
  - Cloned the immutable definition (model, model_snapshot, prompt_version,
    prompt_template, config_snapshot, aggregation_strategy) of the latest known-good
    evaluation request, byte-for-byte (`config_hash`/`prompt_hash` matched the source
    exactly) — new evaluation request `cb1bd6ee-56f7-4d03-a386-85efa7326455`.
  - Enqueued exactly one existing non-legacy `raw_post`
    (`5064ee6e-3bba-4a5f-889a-580a2d868d1c`) under it.
  - Invoked `score-worker` once with `batch_size=1`: **one real OpenAI call**, job
    `8fd3b6a4-635d-444c-9cec-08fd0b624d43` → `succeeded`, `failure_count=0`, exactly one
    `scoring_results` row (`f4f3af44-7036-459d-8544-23c955615659`, `llm_used=true`), no
    duplicates, no unrelated job touched.
  - Invoked `score-worker` a second time with `batch_size=1`: `jobs_read:0, scored:0`,
    confirming the queue was empty and **zero** additional OpenAI calls were made.
  - Closed the evaluation request afterward. Cloud is clean: 0 active requests, empty
    queue, no production request ever created or activated.
- No cron, backfill, or production scoring request was enabled at any point.

## Deliberately deferred, not forgotten

- **Credential rotation** (`INGEST_INTERNAL_SECRET` / similar) — explicitly deferred by
  the user this session. Not a blocker for Phase 3 core completeness; revisit before
  wider/production exposure.
- **Strict 133-row legacy regression** (blocker #8 from session 6, still open) — needs
  the 133-post legacy seed via `../cues-tca-editorial-agent`, not present on every
  machine. This is an **optional follow-up validation**, not unfinished core Phase 3
  implementation — the scoring/circuit-break changes don't touch `ingest` or the legacy
  data path.
- **Broader scoring-quality evaluation** (the old Phase 3F/3G sample-rubric review and
  repeat-drain loop) — optional, non-blocking, gated on an explicit go-ahead for OpenAI
  spend at scale. Nothing production-scored yet: 0 production requests, 0 rows promoted
  via `set_current_scoring_result`.

## How to continue

- A colleague picking this up should branch from `origin/phase3c-circuit-break` until
  the PR into `main` is merged.
- **Phase 4 must start from `origin/phase3c-circuit-break` or a later commit on `main`
  once that PR is merged** — not from any earlier branch.
- **Do not continue from** `origin/phase-3-score-worker`, `origin/phase3c-reconciliation`,
  or `phase3c-test-foundation` — these are superseded intermediate branches from earlier
  in Phase 3C's development and do not contain the circuit-break/lock-order fixes.

```bash
git fetch origin
git checkout -b <your-branch> origin/phase3c-circuit-break
```

## Cloud vs local — exact state

| | Cloud (`bxaovkzemfyxrxbcqask`, eu-west-1, PG 17.6) | Local stack (this machine) |
|---|---|---|
| Migrations | **0001–0013 applied** | 0001–0013 apply cleanly (parity) |
| `score-worker` function | **deployed, ACTIVE, verify_jwt=false** (internal-secret auth), redeployed session 7 with circuit-break/lock-order fixes | code + 32/32 offline test steps |
| Data | 180 raw_posts (133 legacy + 47 non-legacy), 133 analyzed (all simulated), scoring_results include the session-7 smoke-test row, **0 production requests, 0 jobs, queue empty, 0 promoted to current** | no legacy seed on this machine — loader needs `../cues-tca-editorial-agent`, not present |
| `ingest` function | deployed v4, ACTIVE, verify_jwt=false | served locally for tests only |
| Secrets | `RAPIDAPI_KEY`, `INGEST_INTERNAL_SECRET`, `ALLOWED_ORIGINS`, `OPENAI_API_KEY` set — values not recorded here | `.env.test` (gitignored) |
| Extensions | pgmq available + installed (`scoring_jobs` queue live); **no `cron` schema/extension present** | pgmq verified |

## Phase 3C — score-worker — exact state

| File | What it implements |
|---|---|
| `supabase/migrations/0011_scoring_request_circuit_break.sql` | Request-wide client errors (400/401/403/404/422) dead-letter every pending/processing sibling under the same request via `cancel_scoring_request_siblings`, not just the triggering job. |
| `supabase/migrations/0012_scoring_circuit_break_lock_order.sql` | `complete_scoring_job` / `record_scoring_failure` lock the `scoring_requests` row first, before the job row — closes a race between a completing job and a concurrent circuit-break. |
| `supabase/migrations/0013_scoring_enqueue_lock_order.sql` | `enqueue_scoring_job` also locks the request row first — extends the same lock order to the third entry point that touches both a request and job rows, closing the enqueue-vs-circuit-break race. |
| `supabase/functions/score-worker/{index,queue}.ts` | Worker handler + queue RPC wrappers, updated for the above. |
| `supabase/functions/score-worker/__tests__/handler_test.ts` | 32 steps, including 4 new focused tests for the 0013 race (closed-request enqueue rejected, early-enqueued job terminalized on later close, circuit-break-before-enqueue rejected, zero non-terminal jobs survive a closed request). |
| `scripts/verify_scoring.sql` | Extended with the same invariants as hard SQL assertions (section P5), seedless-runnable. |

## Verify locally (any session)

```bash
npx supabase db reset            # applies 0001–0013 (re-run if a container-restart flake trips it)
# then load the legacy seed (see scripts/README.md) if you need the 133-row regression —
# needs ../cues-tca-editorial-agent reachable; not available on every machine

psql "$DB_URL" -v ON_ERROR_STOP=1 -v require_legacy_seed=0 -f scripts/verify_scoring.sql
# seedless mode is sufficient for the circuit-break / lock-order invariants
```

Verify the cloud push specifically:

```bash
npx supabase migration list      # expect 0001-0013 on both local and remote (parity)
```

## Future work (in order)

1. Optional: strict 133-row legacy regression, once the legacy seed is reachable.
2. Optional: broader scoring-quality evaluation (sample rubric review, repeat-drain
   cost/reliability check) before scoring at production scale — requires explicit
   go-ahead on OpenAI spend.
3. Credential rotation, deferred by user choice.
4. **Phase 4+** (anonymise/cluster → generate → review/export/deploy) — see
   `docs/PHASE4_KICKOFF.md` for how to start this without re-auditing Phase 3.

## Open product decisions (defaults chosen, need confirmation)

- **Overall aggregation**: `max_theme_v1` (server-derived max) — evaluation default, not
  final policy. Replaceable without rewriting history.
- **OpenAI model**: pinned to `gpt-5.4-nano-2026-03-17`. Chosen pragmatically, not from a
  full rubric review — the optional Phase 3F-style evaluation may still revise it before
  scoring at production scale.
- **API surface**: Responses API.
- **`included_in_generation`**: stored derived compatibility field now; a separate manual
  editorial-selection field comes with the review phase.

## Hard constraints / gotchas

- Never enable cron without explicit approval. Never make a live OpenAI call without
  explicit approval.
- Service-role / secret keys never reach the frontend; only URL + publishable key.
- `load_legacy.sql` truncates — safe only on an empty target; destructive once a
  pipeline has written real data.
- `db reset` occasionally trips a container-restart timeout; just re-run.
- If ports 54321–54329 are already bound by another local Supabase project, `supabase
  start` fails with "port is already allocated" — stop the other project or remap ports
  in `supabase/config.toml`.

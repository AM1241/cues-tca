# Session handoff — CUES Editorial Cloud

Last updated: 2026-07-24 (session 9 — Phase 4 closure). Read this first, then
`MIGRATION_PLAN.md` and `docs/PHASE4_COMPLETION.md` / `docs/PHASE5_KICKOFF.md`.
This file is the single "where are we" pointer between working sessions.

## Plain-language state (read this first)

**Phase 4 (anonymisation + reproducible clustering) is implemented, deployed,
and smoke-verified. Real-content validation is intentionally deferred to the
first controlled execution — not a blocker for Phase 5.**

| Piece | What it does | Deployed? |
|---|---|---|
| `ingest` Edge Function | pulls LinkedIn posts via RapidAPI | **Yes — live, Phase 2 complete** |
| Scoring database schema + `score-worker` | scores posts via OpenAI | **Yes — Phase 3 core complete** |
| Anonymisation schema + `anonymize-worker` | two-stage anonymisation (deterministic + LLM entity extraction) | **Yes — deployed, `ACTIVE`, v1; zero real posts processed yet** |
| Clustering schema + `cluster` | pgvector embedding + similarity grouping + LLM labeling, per-run immutable record | **Yes — deployed, `ACTIVE`, v1; zero real runs yet** |

- **Canonical branch for this handoff:** `phase4-requirements`
- **Phase 4 implementation commit:** `76a9a53`
- **Phase 4 closure tag:** `phase4-complete` (points at the documentation
  closure commit on `phase4-requirements`)
- **Phase 5 starting branch:** `phase5-generation`, branched from the
  `phase4-complete` tag, no implementation yet
- **Cloud migration ledger:** `0001`–`0015` applied (verified via
  `supabase migration list`)

Full Phase 4 detail — schema corrections, model-isolation proof, embedding
audit behavior, local test results, cloud smoke results, and the deferred
real-data-validation stop conditions — is in `docs/PHASE4_COMPLETION.md`.
Full Phase 5 starting context and open product decisions are in
`docs/PHASE5_KICKOFF.md`. Do not repeat the Phase 4 audit; those documents
are authoritative on Phase 4's state.

## Validation performed (session 9 — Phase 4 closure)

- Local: Deno offline suites (anonymize-worker + cluster), **64 steps, 0
  failed**; `scripts/verify_phase4.sql` with `ON_ERROR_STOP=1`, **exit 0**;
  `deno check` clean; frontend typecheck + production build clean; browser
  verification of the run-failure indicator clean.
- Cloud rollout: migrations `0014`/`0015` pushed and verified object-by-object
  (8 new tables, RLS enabled on all 8, all 11 new RPCs present, new
  `configurations` columns with correct defaults); `anonymize-worker` and
  `cluster` deployed `ACTIVE` v1 `verify_jwt=false`.
- Cloud no-op smoke checks: `anonymize-worker` against the empty queue
  (`jobs_read=0`); `cluster` for a date window with zero eligible posts
  (`eligible=0`, `run_id=null`). Every Phase 4 table and the queue confirmed
  empty before and after both calls.
- **No real-data backfill, no real Phase 4 OpenAI call, at any point this
  session.** `backfill_anonymize_jobs` has never been invoked against cloud.

## Deliberately deferred, not forgotten

- **Real-content validation for Phase 4** — running `anonymize-worker` and
  `cluster` against a small representative set of real scored posts, with
  real OpenAI calls. Deferred to the first controlled execution by explicit
  product decision; see `docs/PHASE4_COMPLETION.md` for the exact stop
  conditions that execution should honor (anonymisation leak, dead-letter,
  total embedding failure, incoherent clustering output).
- **Credential rotation** — `INGEST_INTERNAL_SECRET` was exposed in
  chat/command history during the Phase 4 cloud-rollout preflight (session 8)
  and has been **rotated this session** (new value set via
  `supabase secrets set`; verified against `anonymize-worker`'s empty-queue
  path). No value is recorded in any doc or command output retained from this
  session.
- **Strict 133-row legacy regression** (Phase 3 follow-up, still open) —
  needs the 133-post legacy seed via `../cues-tca-editorial-agent`, not
  present on every machine. Unrelated to Phase 4.
- **Broader scoring-quality evaluation** (Phase 3 follow-up) — optional,
  non-blocking, gated on an explicit go-ahead for OpenAI spend at scale.

## How to continue

- **Phase 5 work starts from `origin/phase5-generation`** (branched from the
  `phase4-complete` tag) — see `docs/PHASE5_KICKOFF.md` for the full starting
  context, the initial Phase 5 goal, and the open product decisions that must
  be resolved before any implementation.
- **Do not start from `phase4-requirements` directly for new work** — it is
  the closed Phase 4 branch; `phase5-generation` is the forward branch.
- **Do not merge `phase4-requirements` into `main`** — that merge has not
  happened as part of this closure and is a separate decision.

```bash
git fetch origin
git checkout -b <your-branch> origin/phase5-generation
```

## Cloud vs local — exact state

| | Cloud (`bxaovkzemfyxrxbcqask`, eu-west-1, PG 17.6) | Local stack (this machine) |
|---|---|---|
| Migrations | **0001–0015 applied** | 0001–0015 apply cleanly (parity) |
| `anonymize-worker` function | **deployed, ACTIVE v1, verify_jwt=false**; zero real invocations (only the empty-queue smoke check, twice — once pre-rotation, once post-rotation) | code + 64/64 offline test steps (combined with `cluster`) |
| `cluster` function | **deployed, ACTIVE v1, verify_jwt=false**; zero real invocations (only the zero-eligible-window smoke check) | same |
| `ingest` / `score-worker` | unchanged from Phase 3 handoff — deployed, ACTIVE | — |
| Data | 180 raw_posts, 133 analyzed, 51 meeting the current relevance threshold (50); `anonymized_posts_current` has 30 rows **predating Phase 4** (a single-batch legacy/seed insert, all sharing one timestamp — not organic worker output; see `docs/PHASE4_COMPLETION.md`); all Phase 4 tables (`anonymize_job_state`, `anonymize_results`, `anonymize_dead_letter`, `clustering_runs`, `post_embeddings`, `clusters`, `cluster_assignments`) and the `anonymize_jobs` queue are **empty** | no legacy seed on this machine |
| Secrets | `RAPIDAPI_KEY`, `INGEST_INTERNAL_SECRET` (**rotated session 9**), `ALLOWED_ORIGINS`, `OPENAI_API_KEY` set — values not recorded here | `supabase/functions/.env.test` (gitignored, separate local-stack-only value, not rotated — it was never the exposed value) |
| Extensions | pgmq (`anonymize_jobs` + `scoring_jobs` queues live), pgvector installed (`0015`); no `cron` schema/extension present | pgmq + pgvector verified |

## Future work (in order)

1. **Phase 5** — generation layer. See `docs/PHASE5_KICKOFF.md` for the
   starting goal and the open product decisions to resolve before writing
   code. Do not implement until those are answered.
2. Deferred: Phase 4's first controlled real-data execution (see stop
   conditions in `docs/PHASE4_COMPLETION.md`) — may happen before, during, or
   independently of Phase 5 work; not a Phase 5 prerequisite.
3. Optional, non-blocking Phase 3 follow-ups: strict 133-row legacy
   regression, broader scoring-quality evaluation at scale.

## Hard constraints / gotchas

- Never enable cron without explicit approval. Never make a live OpenAI call
  without explicit approval.
- Service-role / secret keys never reach the frontend; only URL + publishable
  key.
- `load_legacy.sql` truncates — safe only on an empty target; destructive
  once a pipeline has written real data.
- `db reset` occasionally trips a container-restart timeout; just re-run.
- If ports 54321–54329 are already bound by another local Supabase project,
  `supabase start` fails with "port is already allocated" — stop the other
  project or remap ports in `supabase/config.toml`.
- The Supabase CLI's `db dump` (even `--data-only`) pulls real row content
  (post text, etc.) — avoid it for read-only inspection; use
  `supabase db query --linked "select count(*) ..."` for aggregate checks
  instead, which returns no post content.

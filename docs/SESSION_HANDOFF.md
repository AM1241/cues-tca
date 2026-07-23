# Session handoff — CUES Editorial Cloud

Last updated: 2026-07-24 (session 6). Read this first, then `MIGRATION_PLAN.md` and the
`docs/phase-*-completion.md` records. This file is the single "where are we" pointer
between working sessions.

## Plain-language state (read this first)

Three deployable pieces — **all three now live on the cloud**:

| Piece | What it does | Deployed? |
|---|---|---|
| `ingest` Edge Function | pulls LinkedIn posts via RapidAPI | **Yes — live, Phase 2 complete** |
| Scoring **database schema** (`scoring_requests`, `scoring_results`, lease, prompt snapshot) | tables + RPCs the scorer needs | **Yes — migrations 0001–0010 on cloud** |
| `score-worker` Edge Function | calls OpenAI to score posts | **Yes — deployed & hardened (session 6); Phase 3C/3D/3E complete** |

**Phase 3 is code-complete and validated live.** `score-worker` is deployed
(`verify_jwt=false`, internal-secret auth), the 8 correctness blockers are resolved
(except #8, see below), the model is pinned to `gpt-5.4-nano-2026-03-17`, and real OpenAI
calls have scored posts correctly on the cloud (twice — see session log). What has **not**
been done, deliberately: **3F/3G** — scoring the whole 47-post corpus and promoting real
scores into what editors see. Those are the remaining OpenAI spend and are gated on a
rubric review; nothing production is scored yet (0 production requests, 0 promoted).

"Workers" isn't separate infrastructure — `score-worker` is an Edge Function like `ingest`,
deployed the same way, running on Supabase (Netlify = static frontend only).

## What to do next (pick one, in rough priority order)

1. **Phase 3F — sample evaluation.** Score a ~24-post sample (incl. the 7 historically
   inconsistent overall=0 rows) against a written rubric to confirm/adjust the pinned model,
   then `open_production_scoring_request` + `backfill_scoring_for_request` and promote via
   `set_current_scoring_result`. This is the gate before real scores become what editors
   see. **Needs OpenAI calls** (~$0.01 for all 47) — get a go-ahead on spend.
2. **Phase 3G — repeat-drain loop.** Re-invoke the worker until the queue empties in bounded
   chunks; confirm cost/reliability. Also OpenAI spend.
3. **Blocker #8** (still open) — full `ingest` regression re-run needs the 133-post legacy
   seed (`../cues-tca-editorial-agent`, not on this machine). Accept the gap or get the seed.
4. **Phase 4+** (anonymise/cluster → generate → review/export/deploy).

Note: `INGEST_INTERNAL_SECRET` was **rotated** in session 6 (the old value is dead). The
new value is only in a session scratchpad — if the internal-trigger path is needed again,
re-rotate via `supabase secrets set` or store it durably in a gitignored file.

## Known gap this session

`scripts/verify_rls.sql`, `verify_ingest.sql`, `verify_scoring.sql`, and the `ingest`
Deno regression suite all assume the 133-post legacy seed is loaded. Loading it requires
`../cues-tca-editorial-agent`'s Docker container (see `scripts/README.md`), which is not
present on this machine. They were **not run to completion** this session — don't treat
that as "verified", it's "couldn't be checked here." Schema-level checks (`deno check`,
`db reset`, the score-worker's own self-contained test suite) were run instead and did
pass.

## Cloud vs local — exact state

| | Cloud (`bxaovkzemfyxrxbcqask`, eu-west-1, PG 17.6) | Local stack (this machine) |
|---|---|---|
| Migrations | **0001–0010 applied** | 0001–0010 apply cleanly (parity) |
| `score-worker` function | **deployed, ACTIVE, verify_jwt=false** (internal-secret auth) | code + 18/18 offline tests |
| Data | **180 raw_posts (133 legacy + 47 non-legacy)**, 133 analyzed (all simulated), ~138 `scoring_results` (133 legacy + 5 from eval tests), **0 production requests, 0 jobs, queue empty, 0 promoted to current** | **no legacy seed on this machine** — loader needs `../cues-tca-editorial-agent`, not present |
| `ingest` function | **deployed v4, ACTIVE, verify_jwt=false** | served locally for tests only |
| Secrets | `RAPIDAPI_KEY`, **`INGEST_INTERNAL_SECRET` (rotated session 6)**, `ALLOWED_ORIGINS`, `OPENAI_API_KEY` set | `.env.test` (gitignored) |
| CLI auth | `SUPABASE_ACCESS_TOKEN` + `SUPABASE_DB_PASSWORD` in gitignored `frontend/.env.local` (non-`VITE_`, not bundled) | same |
| Extensions | pgmq available + installed (`scoring_jobs` queue live); pg_cron available, not installed | pgmq verified |
| MCP | `.mcp.json` read-write, **needs SUPABASE_ACCESS_TOKEN in env + Claude restart to activate** (not active in session 6; CLI used instead) | same |

**Delta boundary** (legacy → cloud seed): `2026-07-22T02:17:11.788315+00:00`. The
cloud data is a **dev/test seed**, not the production cutover — see
`docs/cloud-migration-runbook.md` (final cutover needs a write freeze or delta
migration; the truncate-loader is single-use).

## Phase 3C — score-worker — exact state

**As of session 6 this is all applied to cloud and deployed** (see the top of this file);
the table below is the file-by-file map. Session-6 additions: `0009_scoring_worker_lease.sql`
(processing_token claim/lease + superseded) and `0010_scoring_prompt_snapshot.sql`
(prompt template on the request).

| File | What it implements |
|---|---|
| `supabase/migrations/0006_scoring_worker.sql` | `read_scoring_jobs(p_vt, p_qty)` RPC so PostgREST can drain the `pgmq` queue (PostgREST doesn't expose the `pgmq` schema directly). |
| `supabase/migrations/0008_scoring_failure_disposition.sql` | Fixes blocker #4 (below) — added session 5. |
| `supabase/functions/_shared/openai.ts` | OpenAI Responses API client, typed failure modes (`refusal`, `incomplete`, `content_filter`, `rate_limit`, `server_error`, `network`, `timeout`, `client_error`, etc.). |
| `supabase/functions/score-worker/index.ts` | Handler: internal-secret auth only, bounded batch read, one job's failure doesn't abort the batch, model/prompt always from the job's `scoring_requests` row. |
| `supabase/functions/score-worker/queue.ts` | Thin wrappers over the queue RPC + `complete_scoring_job` / `record_scoring_failure`. |
| `supabase/functions/score-worker/prompt.ts` | Per-theme scoring prompt + dynamic JSON schema from the request's themes. |
| `supabase/functions/score-worker/__tests__/{fixtures,handler_test}.ts` | Scripted-OpenAI offline suite, **18/18 passing** (session 6; +4 lease/infra/prompt-snapshot cases). |

### 3C blockers — status (8 of 9 resolved, session 6)

1. ✅ **Atomic claim/lease (`processing_token`).** `0009`: `read_scoring_jobs` stamps a
   fresh `processing_token` (+ `status='processing'`, `leased_at`) when it claims a job.
2. ✅ **Stale/superseded worker rejection.** `0009`: `complete_scoring_job` /
   `record_scoring_failure` take the token and return `'superseded'` (benign, no raise, no
   write, no retry burn) when it no longer matches — a losing worker never aborts the batch.
   Terminal-state calls also return `'superseded'` instead of raising.
3. ✅ **Immutable prompt snapshot.** `0010`: the prompt template is a DB row
   (`public.scoring_prompt_template()`), stored on each request as `prompt_template`
   (`prompt_hash = md5(template)`), and the worker renders from it — not a hardcoded
   constant. Guard extended so the template is immutable after creation.
4. ✅ **OpenAI error disposition / circuit-break.** `0008` (now on cloud): refusal/
   content_filter dead-letter on first occurrence; auth/shape `client_error`
   (400/401/403/404/422) dead-letters + closes the request; transient keeps 30s→120s→
   dead-letter-on-3rd.
5. ✅ **DB-completion failures don't burn a business retry.** `index.ts` splits the OpenAI
   call from the DB write: a completion failure returns `infra_error`, leaves the job
   leased + message un-archived (re-claimed after VT, idempotent), and does not touch
   `failure_count`.
6. ✅ **Hard SQL assertions.** `verify_scoring.sql` sections N/N2 (lease + prompt snapshot)
   and an updated section I (fail-on-terminal → superseded) — all green against cloud.
7. ✅ **Test isolation.** Per-test evaluation requests via `makeEvalRequest()`; the
   circuit-break test uses its own request so ordering no longer matters; new tests
   `drainAmbientQueueNoise()` first. 18/18 passing.
8. ⏳ **OPEN — Full `ingest` regression re-run.** Still blocked on the 133-post legacy seed
   (`../cues-tca-editorial-agent`, not on this machine). The scoring changes don't touch
   `ingest`, but a clean regression hasn't been run here.
9. ✅ **Comment inaccuracy fixed.** The "every migrated analysis has flat 0.0 per-theme
   scores" claim was wrong (all 133 legacy results have varied non-zero scores, verified);
   removed when `prompt.ts` was rewritten for #3.

Validated: `deno check` clean, `db reset` 0001–0010, offline suite **18/18**,
`verify_scoring.sql` all green vs cloud, and a live 2-post smoke test on the deployed worker
(`gpt-5.4-nano-2026-03-17`, scored correctly, non-destructive).

## This session (session 6) — what actually happened, in order

1. Validated the scoring mechanism live (Phase 3E): deployed `score-worker`, pushed
   `0006`/`0007`/`0008` to cloud, rotated `INGEST_INTERNAL_SECRET`, created an **evaluation**
   request, enqueued 3 posts, and made real `gpt-5.4-nano` calls — 92/85/0 scores,
   non-destructive (no promotion). Confirmed the whole path works.
2. Completed Phase 3C hardening offline (no OpenAI): `0009_scoring_worker_lease.sql`
   (processing_token claim/lease + superseded), `0010_scoring_prompt_snapshot.sql`
   (prompt template on the request), worker changes (`index.ts`/`queue.ts`/`prompt.ts`),
   +4 tests (18/18), extended `verify_scoring.sql`, comment fix. `deno check` clean.
3. Pinned the model (3D): `gpt-5.4-nano-2026-03-17`.
4. Pushed `0009`/`0010` to cloud + redeployed the worker. **Hit and fixed a real migration
   bug**: `0010`'s backfill ran after the immutability guard was recreated to protect
   `prompt_template`, so the guard blocked the backfill on the cloud (which has existing
   rows); invisible locally because a fresh `db reset` has none. Reordered backfill before
   the guard; re-pushed clean. (The one pre-existing closed eval request has a
   `prompt_hash` that no longer matches its backfilled template — cosmetic, the 0005 guard
   blocks fixing `prompt_hash` on existing rows; harmless, it's closed.)
5. Ran `verify_scoring.sql` against cloud (rolled back) — all green. Ran a live 2-post
   smoke test on the deployed, hardened worker with the pinned snapshot — scored correctly
   (78 supply-chain / 75 sustainability), `provider_response` stored, 0 promoted. Closed
   the request; cloud clean (0 active requests, empty queue).
6. Updated `MIGRATION_PLAN.md` + this file. Nothing committed to git this session.

## Previous session (session 5) — what actually happened, in order

1. Pulled `590ef0f` (session 4's score-worker draft) from `origin/main`.
2. Renamed a local, unrelated, pre-existing untracked migration from `0006_...` to
   `0007_source_last_fetched.sql` (a `sources.last_fetched_at` stamping trigger — nothing
   to do with Phase 3, just avoided colliding with the newly-pulled `0006_scoring_worker.sql`
   filename). Not otherwise touched, out of scope for Phase 3C.
3. Upgraded the local Supabase CLI 2.75.0 → 2.109.1 (`/usr/local/bin/supabase`) — the old
   CLI couldn't parse `supabase/config.toml` (`experimental.pgdelta`, `local_smtp` keys
   are newer than 2.75.0 understands). This machine had never run `supabase start` for
   this project before.
4. Resolved a port conflict on `54322` with an unrelated local Supabase project
   (`supabase-local`) by stopping it (user confirmed). Local stack for `cues` started
   clean, migrations 0001–0007 applied.
5. Reconfirmed `deno check` clean and the score-worker offline suite 12/12 — matched
   session 4's report exactly, no drift.
6. Created `supabase/functions/.env.test` locally (gitignored) with a freshly generated
   `INGEST_INTERNAL_SECRET` — didn't exist on this machine before.
7. Attempted `verify_rls.sql` / `verify_ingest.sql` / `verify_scoring.sql` — all fail
   immediately on missing `sources` data, because the legacy seed loader needs
   `../cues-tca-editorial-agent`, not present on this machine. Logged as a known gap, not
   a regression.
8. Implemented blocker #4 (see above): new migration `0008_scoring_failure_disposition.sql`,
   2 new offline tests, 1 existing test corrected. 14/14 passing, confirmed against a
   fully fresh `db reset`. Applied locally only — **not pushed to cloud**.
9. Updated `MIGRATION_PLAN.md` and this file. Nothing committed to git this session —
   `git status` still shows the same files as modified/untracked as when the session
   started, plus the new migration and test changes.

## Verify locally (any session)

```bash
npx supabase db reset            # applies 0001–0010 (re-run if a container-restart flake trips it)
# then load the legacy seed (see scripts/README.md: snapshot -> build loader -> psql)
# — needs ../cues-tca-editorial-agent reachable; not available on every machine
psql "$DB_URL" -f scripts/verify_rls.sql       # Phase 1
psql "$DB_URL" -f scripts/verify_ingest.sql    # Phase 2
psql "$DB_URL" -f scripts/verify_scoring.sql   # Phase 3B  (expect 37 RESULT, 0 BAD)

# score-worker offline suite — does NOT need the legacy seed, just a running local stack:
source <(supabase status -o env | grep -v '^Stopped')
INGEST_INTERNAL_SECRET=$(grep INGEST_INTERNAL_SECRET supabase/functions/.env.test | cut -d= -f2)
docker run --rm --network supabase_network_cues-editorial-cloud \
  -v "$PWD/supabase/functions:/app" -w /app \
  -e SUPABASE_URL=http://kong:8000 -e SUPABASE_ANON_KEY="$ANON_KEY" \
  -e SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" -e OPENAI_API_KEY=dummy-not-used \
  -e INGEST_INTERNAL_SECRET="$INGEST_INTERNAL_SECRET" \
  denoland/deno:alpine-2.5.2 deno test --allow-env --allow-net score-worker/__tests__/
```

Verify the cloud push specifically:

```bash
npx supabase migration list      # expect 0001-0010 on both local and remote (parity)
```

## Future work (in order)

1. Resolve remaining Phase 3C blockers #1, #2, #3, #5–#9 (above) — all local-only work.
2. Get the legacy seed onto whichever machine works this next, so the full verify suite
   and `ingest` regression can actually run (or explicitly accept the gap and move on).
3. **Phase 3D** — pin an exact OpenAI model snapshot (not yet chosen).
4. **Phase 3E** — one controlled cloud scoring call, EC post only (~$0.0003), **requires
   explicit approval first**.
5. **Phase 3F** — score a ~24-post sample against a written rubric, then
   `open_production_scoring_request` + backfill. Promotion gate before real scores go live.
6. **Phase 3G** — confirm repeated draining works within cost/reliability bounds.
7. **Phases 4–7**: anonymise + pgvector clustering; generation; frontend; review/export/
   deploy + final cutover.
8. **Activate the Supabase MCP server** (optional, not blocking): generate a Personal
   Access Token, set `SUPABASE_ACCESS_TOKEN` locally, restart Claude Code. It's read-write
   — treat its write tools with the same caution as `supabase db push`.

## Open product decisions (defaults chosen, need confirmation)

- **Overall aggregation**: `max_theme_v1` (server-derived max) — evaluation default, not
  final policy. Replaceable without rewriting history.
- **OpenAI model**: **pinned to `gpt-5.4-nano-2026-03-17`** (400k context / 128k max output;
  structured outputs via the Responses API confirmed live). Chosen pragmatically from the
  3E validation, not a full 3F rubric — 3F may still revise it before production scores go
  live. Cost trivial (~cents/mo); Batch API deferred.
- **API surface**: Responses API (per Phase 3B decision).
- **`included_in_generation`**: stored derived compatibility field now; a separate manual
  editorial-selection field comes with the review phase.
- **Supabase MCP scope**: read-write (user's explicit choice). Revisit if that proves too
  permissive once actually used.

## Hard constraints / gotchas

- Never enable cron without explicit approval. Never make a `dry_run=false` or live
  OpenAI call without explicit approval.
- Service-role / secret keys never reach the frontend; only URL + publishable key.
- `load_legacy.sql` truncates — safe only on an empty target; destructive once a
  pipeline has written real data.
- Fratelli/MASAF `rapidapi_identifier`s are canonicalized (not the exact proven forms) —
  pin the proven form before any live call to those, as done for EC.
- `db reset` occasionally trips a container-restart timeout; just re-run.
- If ports 54321–54329 are already bound by another local Supabase project, `supabase
  start` fails with "port is already allocated" — stop the other project or remap ports
  in `supabase/config.toml`.
- The Supabase MCP server in `.mcp.json` is **read-write** and scoped to the live cloud
  project — once activated, treat its write-capable tools with the same caution as
  `supabase db push` (confirm before any state-changing call).

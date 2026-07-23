# Session handoff — CUES Editorial Cloud

Last updated: 2026-07-23 (session 3 — frontend). Read this first, then `MIGRATION_PLAN.md`
and the `docs/phase-*-completion.md` records. This file is the single "where are we"
pointer between working sessions.

## One-paragraph state

Phases 0, 1 and 2 are **complete and live on the cloud**. Phase 3A/3B (scoring design +
database layer) are **complete and applied to the cloud** — `0005_scoring.sql` is live,
types are regenerated and committed. The `score-worker` Edge Function (3C) is **not built**;
no OpenAI call has ever been made; cron is not enabled anywhere. **Phase 6 (frontend) is now
in progress in parallel** — 5 of 6 routes built against the cloud seed (Posts, Sources,
Objective, Review, Export) plus an email+password auth gate; only Generate remains a
placeholder (blocked on Phase 5). The legacy system (`../cues-tca-editorial-agent` Docker
container + volume) is untouched and remains authoritative until Phase 7.

## What happened this session (session 3 — frontend)

Frontend work only; **no schema, migration, or cloud-DB changes**. `database.types.ts`
treated as read-only (owned by the Phase 3 sessions — not regenerated).

1. **Phase 0 finish + repo setup on the frontend machine**: `git init`, added `origin`
   (SSH — HTTPS had no credentials), pulled `main`. `npm install` in `frontend/`.
   `frontend/.env.local` confirmed to hold only the cloud URL + publishable key.
2. **Auth (Phase 6)**: email+password login via `signInWithPassword` (not magic-link).
   `useAuth` hook resolves `isEditor` from `public.editors`; three-state gate
   (login / awaiting-access / app). The one existing user (`hzafeiris@f-in.eu`, admin on
   the allowlist) had its **login password reset to `123456` for testing** — change before
   production.
3. **Built 5 routes** against the cloud seed: Posts (read), Sources (CRUD, no delete),
   Objective (config-row editor), Review (asset approval + traceability, RLS-granted columns
   only), Export (client-side MD/JSON). Generate left as a placeholder. Added
   `react-router-dom`, an `ErrorBoundary`, a toast system, and shared UI primitives.
4. **Everything verified** via `tsc -b`, `oxlint`, and a production `vite build` — all clean.
   Writes were not all click-tested as the authed user; the RLS grants were matched to the
   `0002` migration by hand.

### Earlier sessions

1. **Reviewed session 1's handoff**, confirmed via `supabase migration list` that cloud
   was on 0001–0004 with 0005 pending locally only.
2. **Pushed `0005_scoring.sql` to the cloud** (`bxaovkzemfyxrxbcqask`) after explicit
   user confirmation — `npx supabase db push`. Confirmed applied via
   `supabase migration list` (local and remote both report `0005`). The push emitted a
   non-fatal warning (`failed to cache migrations catalog` / missing
   `pgdelta-target-ca.crt`) — cosmetic, unrelated to whether the migration itself
   applied; verified separately that it did.
3. **Regenerated `frontend/src/lib/database.types.ts`** against the linked cloud project
   (`supabase gen types typescript --linked`) and committed it
   (`c320d70`).
4. **Prepared the frontend env handoff** for a colleague joining frontend work.
   `frontend/.env.local` already held the correct values (cloud URL +
   publishable key only — no secrets); pointed the user at it, no changes needed.
5. **Added a Supabase MCP server** (`.mcp.json`, commit `9a8f59a`) — `@supabase/mcp-server-supabase`,
   **read-write**, scoped via `--project-ref=bxaovkzemfyxrxbcqask`. No token is stored
   in the repo; each contributor sets `SUPABASE_ACCESS_TOKEN` locally (shell env or
   `.claude/settings.local.json`, both gitignored). **Not yet exercised in a session** —
   needs a Personal Access Token from
   `supabase.com/dashboard/account/tokens` and a Claude Code restart before it's live.
   Chosen deliberately read-write (not `--read-only`) per user's explicit choice —
   means Claude can write to the cloud DB directly through MCP, not just via reviewed
   migrations. Worth revisiting if that turns out to be too permissive in practice.

## Cloud vs local — exact state

| | Cloud (`bxaovkzemfyxrxbcqask`, eu-west-1, PG 17.6) | Local stack |
|---|---|---|
| Migrations | **0001–0005 applied** | 0001–0005 apply cleanly |
| `0005_scoring.sql` | **applied 2026-07-23** | applied + tested |
| Data | 134 raw_posts (133 legacy + 1 EC), 133 analyzed (all simulated), 133 `scoring_results` (legacy import), 0 scoring jobs, no scoring request, 15 assets, 89/469 traceability, 4 sources | reproduced via loader (133 raw; EC post is cloud-only) |
| `ingest` function | **deployed v4, ACTIVE, verify_jwt=false** | served locally for tests |
| Secrets | `RAPIDAPI_KEY`, `INGEST_INTERNAL_SECRET`, `ALLOWED_ORIGINS`, `OPENAI_API_KEY` set | `.env.test` (gitignored) |
| Extensions | pgmq 1.5.1 + pg_cron 1.6.4 **available, not installed** | pgmq verified |
| MCP | `.mcp.json` added, read-write, **needs SUPABASE_ACCESS_TOKEN set locally to activate** | same |

**Delta boundary** (legacy → cloud seed): `2026-07-22T02:17:11.788315+00:00`. The
cloud data is a **dev/test seed**, not the production cutover — see
`docs/cloud-migration-runbook.md` (final cutover needs a write freeze or delta
migration; the truncate-loader is single-use).

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

Verify the cloud push specifically:

```bash
npx supabase migration list      # expect 0001-0005 on both local and remote
```

## Future work (in order)

1. **Activate the Supabase MCP server.** Generate a Personal Access Token
   (`supabase.com/dashboard/account/tokens`), set `SUPABASE_ACCESS_TOKEN` locally,
   restart Claude Code. Then it can replace ad-hoc `npx supabase` / `psql` calls for
   inspection — remember it is read-write, so treat its write tools with the same
   care as a direct migration.
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
- **Supabase MCP scope**: set up read-write rather than read-only (user's explicit
  choice this session). Revisit if write-through-MCP proves risky once it's actually
  used.

## Hard constraints / gotchas

- Never enable cron without explicit approval. Never make a `dry_run=false` or
  live OpenAI call without explicit approval.
- Service-role / secret keys never reach the frontend; only URL + publishable key.
- `load_legacy.sql` truncates — safe only on an empty target; destructive once a
  pipeline has written real data.
- Fratelli/MASAF `rapidapi_identifier`s are canonicalized (not the exact proven
  forms) — pin the proven form before any live call to those, as done for EC.
- `db reset` occasionally trips a container-restart timeout; just re-run.
- On this machine, `node`/`npm`/`npx` are installed at `C:\Program Files\nodejs` but
  are **not on PATH** in the Bash tool's shell — prefix commands with
  `export PATH="/c/Program Files/nodejs:$PATH"` or call PowerShell instead.
- The Supabase MCP server in `.mcp.json` is **read-write** and scoped to the live
  cloud project — once activated, treat its write-capable tools with the same
  caution as `supabase db push` (confirm before any state-changing call).

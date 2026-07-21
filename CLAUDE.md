# CUES Editorial Cloud

Collects LinkedIn posts from food-industry organisations, scores them for editorial
relevance, anonymises company names, clusters them into themes, and generates
LinkedIn-ready editorial copy for human approval.

Supabase (Postgres + Edge Functions + Auth) with a static React frontend on Netlify.
Internal tool for the CUES editorial team, ~10 users, low traffic, batch workloads.

**Status: being built.** This repo is a cloud rewrite of `../cues-tca-editorial-agent`
(FastAPI + SQLite + Docker). Until `MIGRATION_PLAN.md` is fully checked off, expect parts
of the tree below to be missing. Do not describe unbuilt phases as done.

## Layout

```
supabase/
  migrations/          SQL schema + RLS policies, applied in filename order
  functions/           Edge Functions (Deno + TypeScript), one dir per function
frontend/              Vite + React + TS + Tailwind, static build -> Netlify
docs/                  Reference material, see below
```

## Stack decisions

Deno/TypeScript everywhere on the server side — there is no Python. The legacy pipeline was
regex, string munging and LLM HTTP calls; nothing in it required numpy, spacy or
sentence-transformers despite those being in the old requirements file.

Postgres is the only state. No local SQLite, no files on disk — batch payloads and exports
go to Supabase Storage.

Config (themes, voice, `min_relevance_score`, company aliases) is a **database row**, not
env vars or code. Operators change editorial direction by editing config, then re-running
the pipeline. Preserve that property in anything you add.

## Pipeline order

Stages are not independent — each reads the previous stage's table, and running them out of
order yields empty results rather than errors.

```
raw_posts -> analyzed_posts -> anonymized_posts_current -> editorial_assets
 ingest        score             anonymize                   generate
```

`generate` reads **only** `anonymized_posts_current`. Skipping anonymise is the single most
common cause of "no output".

## Working here

```bash
supabase start                       # local Postgres + Edge runtime, needs Docker
supabase db reset                    # re-apply every migration from scratch
supabase functions serve <name>      # run one function locally with hot reload
cd frontend && npm run dev
```

Schema changes are new files in `supabase/migrations/` — never edit an applied migration,
and never change the schema through the Studio UI without generating a migration for it.
After a schema change, regenerate types: `supabase gen types typescript --local > frontend/src/lib/database.types.ts`.

Verify a change by calling the function against the local stack and reading the affected
table. Do not assume an LLM-backed function worked because it returned 200 — check the
`llm_used` field on the response, which is false when the call fell back.

## Secrets

Edge Function secrets (`OPENAI_API_KEY`, `RAPIDAPI_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) live
in Supabase, set via `supabase secrets set`. Only the anon key and project URL may reach the
frontend bundle. The service role key bypasses RLS — it must never appear in `frontend/`,
in a `VITE_` variable, or in Netlify env.

RLS is on for every table. A new table without policies is a security hole, not a default.

## Reference

- `MIGRATION_PLAN.md` — phased plan, current progress, and the rationale for each decision.
- `docs/legacy-system.md` — how the old FastAPI app worked, its data model, and the bugs and
  dead code not to carry over. Read before porting any stage.
- `docs/editorial-brief.md` — the CUES editorial objective and voice, used in prompts.

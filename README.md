# CUES Editorial Cloud

Collects LinkedIn posts from food-industry organisations, scores them for editorial
relevance, anonymises company names, clusters them into themes, and generates
LinkedIn-ready editorial copy for human approval.

Supabase (Postgres + Edge Functions + Auth) with a static React frontend on Netlify.
Internal tool for the CUES editorial team.

**Status: Phase 3 core complete and deployed.** See
[docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md) and
[MIGRATION_PLAN.md](MIGRATION_PLAN.md) for the phased plan and current progress.

## Layout

```
supabase/
  migrations/   SQL schema + RLS policies, applied in filename order
  functions/    Edge Functions (Deno + TypeScript)
frontend/       Vite + React + TS + Tailwind, static build -> Netlify
docs/           Reference material
```

## Pipeline

```
raw_posts -> analyzed_posts -> anonymized_posts_current -> editorial_assets
 ingest        score             anonymize                   generate
```

Stages are not independent — each reads the previous stage's table. `generate` reads
**only** `anonymized_posts_current`.

## Local development

Requires Node.js and Docker.

```bash
npm install                      # installs the Supabase CLI
npx supabase start               # local Postgres + Edge runtime
npx supabase db reset            # re-apply every migration from scratch

cd frontend
cp .env.example .env.local       # fill in project URL + publishable key
npm install
npm run dev
```

## Secrets

Edge Function secrets (`OPENAI_API_KEY`, `RAPIDAPI_KEY`) are set with
`npx supabase secrets set`. Only the project URL and the publishable (anon) key may
reach the frontend bundle. The secret / service-role key bypasses RLS and must never
appear in `frontend/`, in a `VITE_` variable, or in Netlify env.

RLS is enabled on every table. A new table without policies is a security hole, not a
default.

# Production helpers

Small scripts used against the live project `bxaovkzemfyxrxbcqask` since 2026-11-17. They
read the Supabase access token from the Windows User-scope variable
`SUPABASE_ACCESS_TOKEN`; no secret is stored here. All SQL goes through the Management API
`/v1/projects/{ref}/database/query`, not `db push`.

## The operator's rules

- **Read-only checks** (`query_ro.ps1`) on production: allowed without asking.
- **Any change** to production (schema, data, function deploy, frontend push, signing in as
  the operator) only on the operator's explicit go-ahead for that specific action. A general
  "go on" does not cover a different action, and the auto-mode classifier enforces this.
- **First a rolled-back test**, then the real change, then a read-only re-check.

## Files

| File | What it does |
| --- | --- |
| `query_ro.ps1 <file.sql>` | Runs one SQL file read-only and prints the rows. |
| `query_rw.ps1 <file.sql>` | Runs one SQL file with writes allowed. Only for a dry run or an authorised apply. |
| `make_0034_sql.example.js <migration> <outDir>` | How 0034 was rolled out: writes `dry_0034.sql` and `apply_0034.sql`. Copy and adapt for the next migration. |
| `snapshot_export.ps1 <outDir>` | Exports every public table read-only as JSON, for a local copy. |
| `make_local_load_sql.js <snapshotDir> <out.sql>` | Turns that export into one transaction for the **local** Docker database. |

Keep snapshot output **outside the repo**: it holds real posts and the editors' emails.

## Rolling out a migration

1. Build the two files (`node make_00NN_sql.js supabase/migrations/00NN_x.sql <tmpDir>`):
   - `dry_00NN.sql`: one `do $dry$ … $dry$` block that `execute`s each statement, measures
     what matters (row counts, the scoring hash
     `scoring_hash_of_snapshot(scoring_config_snapshot())`, grants, constraint checks) and
     ends in `raise exception 'DRY RUN, ROLLED BACK | …'`, so the API answers 400 with the
     measurements and nothing is kept.
   - `apply_00NN.sql`: `begin;` + the migration + an insert into
     `supabase_migrations.schema_migrations (version, name, statements)` + `commit;`.
2. `query_ro.ps1` a before-state, `query_rw.ps1 dry_00NN.sql`, `query_ro.ps1` again to
   confirm nothing was left, then, with the go-ahead, `query_rw.ps1 apply_00NN.sql` and a
   final `query_ro.ps1`.

## Deploying a function or the frontend

```powershell
$env:SUPABASE_ACCESS_TOKEN = [Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', 'User')
npx supabase functions deploy <name> --project-ref bxaovkzemfyxrxbcqask
```

Check the version with `GET /v1/projects/{ref}/functions/<name>` and the deployed code with
`…/functions/<name>/body` (search it for the prompt version strings).

Netlify builds `phase6-frontend-binding` on push. Run `npm run build` in `frontend/` first
(it reads `frontend/.env.local`, which points at production), note the
`dist/assets/index-*.js` name, push, then wait until `https://cues-tca.netlify.app/` serves
that name and compare the file byte for byte.

## Seeing the UI on real data without signing in as the operator

`snapshot_export.ps1` → `make_local_load_sql.js` → load into the local stack with
`docker exec -i supabase_db_cues-editorial-cloud psql -U postgres -d postgres < out.sql`,
create a local-only editor through the local GoTrue admin API, and run `vite` with
`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` of the local stack set in the process
environment (they override `.env.local`). The local stack has no edge runtime, so action
buttons do not work there; mock them with Playwright `page.route` when a flow needs them.
`supabase db reset` wipes the copy.

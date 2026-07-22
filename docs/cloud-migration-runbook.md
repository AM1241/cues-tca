# Phase 1 cloud migration runbook

Applies the Phase 1 schema to the linked cloud project (`bxaovkzemfyxrxbcqask`,
`cues-tca`, eu-west-1) and loads the legacy data into it.

**Run every command yourself.** Nothing here requires sending a password, a
database URL or a key through chat. `supabase db push` prompts for the database
password interactively; the data load reads it from an environment variable you
set in your own shell.

> `npx supabase db push` applies **schema only**. It does not move a single row.
> The data load is step 5 and is a separate, manual operation.

---

## Before you start

- The legacy container `cues-editorial-agent-api` must still be running. This
  runbook only reads from it. **Nothing here stops, deletes or modifies the
  legacy system**, and it stays the source of truth until Phase 7 passes.
- Have the database password to hand — Dashboard → Project Settings → Database.
  If you never set one, reset it there; it is not the same as your account
  password or your access token.
- Work from the repo root.

---

## 1. Fresh consistent snapshot

The research snapshot taken during development is **stale** — the legacy app has
been running since. Take a new one immediately before migrating so the load
reflects the data as it is now.

```powershell
docker cp scripts/snapshot_legacy.py cues-editorial-agent-api:/tmp/snapshot.py
docker exec cues-editorial-agent-api python /tmp/snapshot.py
docker cp cues-editorial-agent-api:/tmp/legacy_snapshot.db ./legacy_snapshot.db
```

This uses the SQLite Online Backup API against a **read-only** handle, so it is
transactionally consistent even while the FastAPI process writes.

## 2. Integrity checks — stop if these are not clean

Step 1 prints them. Both must read exactly:

```
integrity_check: ok
foreign_key_check rows: 0
```

It also prints per-table row counts. Note them; step 6 compares against these,
not against the numbers from development. **If the counts differ from
4 / 133 / 133 / 133 / 30 / 15 / 15 / 89 / 1, that is expected** — the legacy app
may have collected more posts. Use what step 2 reports as truth.

## 3. Generate the loader from that fresh snapshot

```powershell
node scripts/build_legacy_loader.mjs ./legacy_snapshot.db ./load_legacy.sql
```

Read its summary before continuing:

```
external_post_id: recovered=<n> null=<n>
link_post_refs=<n> unresolved=0          <-- MUST be 0
provenance: simulated_fallback=<n> legacy_unverified=<n>
```

`unresolved` must be `0`. Anything else means a traceability link points at a
post that no longer exists; stop and investigate rather than loading partial
provenance.

## 4. Push the schema

```powershell
npx supabase db push
```

Prompts for the database password. It applies `0001_schema.sql` then
`0002_auth_rls.sql`. Confirm both are listed as applied.

Sanity check that RLS actually landed — Dashboard → SQL Editor:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
```

All 11 tables must show `rowsecurity = true`. If any is false, stop.

## 5. Load the data, transactionally

`load_legacy.sql` is already wrapped in `begin; … commit;` and truncates its
target tables first, so it is atomic and re-runnable. It is roughly 1 MB — too
large for the dashboard SQL editor, so use `psql`.

You do not need psql installed: the local Supabase database container has it.

Get the connection string from Dashboard → **Connect** → *Session pooler*
(use the pooler, not `db.<ref>.supabase.co` directly — the direct host is
IPv6-only and will fail on most home connections).

```powershell
# Prompts, and keeps the password out of your shell history:
$pw = Read-Host "DB password" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))

# Replace <REGION> and <USER> with the values from the Connect dialog.
$CLOUD = "postgresql://<USER>@aws-0-<REGION>.pooler.supabase.com:5432/postgres"

Get-Content ./load_legacy.sql -Raw -Encoding UTF8 |
  docker exec -i -e PGPASSWORD="$env:PGPASSWORD" supabase_db_cues-editorial-cloud `
    psql "$CLOUD" -v ON_ERROR_STOP=1
```

Expect it to end with `COMMIT`. On any error the whole transaction rolls back
and the cloud database is left untouched — fix and re-run.

Clear the variable when done:

```powershell
Remove-Item Env:\PGPASSWORD
```

## 6. Reconcile the cloud database

Dashboard → SQL Editor. Compare every number against what **step 2** printed.

```sql
-- Row counts
select 'sources' t, count(*) from sources
union all select 'raw_posts', count(*) from raw_posts
union all select 'normalized_posts', count(*) from normalized_posts
union all select 'analyzed_posts', count(*) from analyzed_posts
union all select 'anonymized_posts_current', count(*) from anonymized_posts_current
union all select 'generation_requests', count(*) from generation_requests
union all select 'editorial_assets', count(*) from editorial_assets
union all select 'traceability_links', count(*) from traceability_links
union all select 'traceability_link_posts', count(*) from traceability_link_posts
union all select 'configurations', count(*) from configurations
order by 1;

-- Orphans across all eight FK paths. Every row must be 0.
select 'raw->source' k, count(*) from raw_posts r left join sources s on s.id=r.source_id where s.id is null
union all select 'norm->raw', count(*) from normalized_posts n left join raw_posts r on r.id=n.raw_post_id where r.id is null
union all select 'analyzed->raw', count(*) from analyzed_posts a left join raw_posts r on r.id=a.raw_post_id where r.id is null
union all select 'anon->raw', count(*) from anonymized_posts_current a left join raw_posts r on r.id=a.raw_post_id where r.id is null
union all select 'asset->genreq', count(*) from editorial_assets e left join generation_requests g on g.id=e.generation_id where g.id is null
union all select 'link->asset', count(*) from traceability_links l left join editorial_assets e on e.id=l.asset_id where e.id is null
union all select 'linkpost->link', count(*) from traceability_link_posts p left join traceability_links l on l.id=p.link_id where l.id is null
union all select 'linkpost->raw', count(*) from traceability_link_posts p left join raw_posts r on r.id=p.raw_post_id where r.id is null;

-- Duplicates. Every row must be 0.
select 'dup (source_id,external_post_id)' k, count(*) from (
  select source_id, external_post_id from raw_posts
  where external_post_id is not null group by 1,2 having count(*) > 1) z
union all select 'dup legacy_id', count(*) from (
  select legacy_id from raw_posts group by 1 having count(*) > 1) z
union all select 'dup norm raw_post', count(*) from (
  select raw_post_id from normalized_posts group by 1 having count(*) > 1) z
union all select 'dup analyzed raw_post', count(*) from (
  select raw_post_id from analyzed_posts group by 1 having count(*) > 1) z;

-- Provenance. Must match step 3, and llm_used must never be true here.
select provenance, is_legacy, llm_used, count(*)
from editorial_assets group by 1,2,3 order by 1;

-- Traceability references: total must equal link_post_refs from step 3,
-- and every link must retain at least one post.
select count(*) as total_refs,
       count(distinct link_id) as links_with_refs,
       (select count(*) from traceability_links) as links_total,
       (select count(*) from traceability_links l
        where not exists (select 1 from traceability_link_posts p where p.link_id = l.id)) as links_with_no_posts
from traceability_link_posts;
```

`links_with_no_posts` must be `0` and `links_with_refs` must equal `links_total`.

Pass criteria, all of which must hold:

| Check | Expected |
|---|---|
| Row counts | identical to step 2 |
| Orphans (8 paths) | all 0 |
| Duplicates (4 checks) | all 0 |
| `links_with_no_posts` | 0 |
| `total_refs` | equals `link_post_refs` from step 3 |
| `llm_used` on legacy rows | `false` or `null`, never `true` |
| RLS | `rowsecurity = true` on all 11 tables |

## 7. Stop here

Do **not** touch the legacy system. Leave `cues-editorial-agent-api` running and
its Docker volume intact until Phase 7 has been signed off end to end.

Delete the local working copies once reconciliation passes — they contain real
post content and are reproducible from step 1:

```powershell
Remove-Item ./legacy_snapshot.db, ./load_legacy.sql
```

Next: `docs/first-editor-bootstrap.md`. Until that is done `public.editors` is
empty, and RLS will correctly show every signed-in user zero rows.

---

## If something goes wrong

**`db push` says the schema is already applied but tables are missing** — the
migration history table is out of step with reality. Do not force. Inspect
`supabase_migrations.schema_migrations` in the SQL editor first.

**The load fails partway** — nothing was written; it is one transaction. Re-run
after fixing.

**You need to start the data over** — re-running `load_legacy.sql` truncates and
reloads. Safe before the app is live, destructive afterwards.

**Counts are higher than development's 133** — correct and expected. The legacy
app kept collecting. Step 2 is the reference, not this document.

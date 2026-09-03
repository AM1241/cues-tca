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

## What this migration is, and is not

**This is a development and test seed. It is not the production cutover.**

The legacy application keeps running and keeps collecting throughout Phases 2–7.
The moment step 1's snapshot is taken, the cloud copy begins drifting from it —
by Phase 6 it will be materially behind. That is fine and expected: the point of
this load is to give the Phase 2–6 work realistic data to build and test
against, not to be the system of record.

Consequences worth internalising now:

- The legacy Docker container and its volume stay untouched and authoritative
  until Phase 7 is signed off.
- Cloud data is **disposable up to the point the new pipeline starts writing**
  its own rows — the first real `ingest` run in Phase 2. After that it is not.
- **`load_legacy.sql` truncates before loading. Never run it again once the
  cloud pipeline has produced anything of its own.** It would silently destroy
  every post ingested by Phase 2, every score from Phase 3, every anonymisation
  from Phase 4 and every asset generated in Phase 5 — including editorial work a
  human has already reviewed and approved. The truncate is safe exactly once, on
  an empty cloud database, and never again.

The real cutover is a separate operation, specified in
[Final cutover](#final-cutover-phase-7) below. Read it before Phase 2, not after
Phase 6 — it is the reason step 2.5 asks you to write down a timestamp.

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

## 2.5 Record the delta boundary — do not skip this

Step 1 prints `snapshot_taken_at_utc:` followed by an ISO timestamp, then the
per-table row counts. **Write both down now**, in the migration log below, in a
ticket, wherever you will still find them in three months.

This timestamp is the line between what the cloud has and what the legacy system
went on to collect. Without it, final cutover has no way to compute a delta and
degrades into "copy everything again and hope", which by then is destructive.

Fill this in and commit it:

```text
Phase 1 cloud load
  snapshot_taken_at_utc : ____________________________________
  loaded_at_utc         : ____________________________________
  source row counts at snapshot:
    sources ____  raw_posts ____  normalized_posts ____  analyzed_posts ____
    anonymized_posts_current ____  generation_requests ____
    editorial_assets ____  traceability_links ____  configurations ____
  loader summary:
    external_post_id recovered ____ / null ____
    link_post_refs ____   unresolved 0
    provenance: simulated_fallback ____  legacy_unverified ____
```

The legacy `raw_posts` carry no reliable modification timestamp, but they do
carry `collected_at`, and `legacy_id` is stable and unique. Between them the
delta at cutover is computable: rows whose `legacy_id` is absent from the cloud
are new, and `collected_at > snapshot_taken_at_utc` narrows the search.

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

Go to Dashboard → **Connect** → **Session pooler** and **copy the connection
string exactly as shown**, whole. Do not retype it or assemble it from parts:
the username encodes the project ref, the host and port differ per region and
per pooler mode, and the string carries SSL parameters (`?sslmode=require`, and
sometimes more) that must survive verbatim. Guessing any of it produces either a
refused connection or, worse, an unencrypted one.

Use the pooler, not `db.<ref>.supabase.co` — the direct host is IPv6-only and
will fail on most home connections.

The copied string contains a `[YOUR-PASSWORD]` placeholder. **Delete that
placeholder** so the URI holds no password at all, leaving
`postgresql://user@host:port/postgres?sslmode=require`, and let `PGPASSWORD`
supply it instead. That keeps the secret out of the process list and out of
`psql`'s history.

```powershell
# Paste the string from the Connect dialog, minus the :[YOUR-PASSWORD] part.
$CLOUD = "<paste Session pooler connection string here, password removed>"

# Prompts, and keeps the password out of your shell history:
$pw = Read-Host "DB password" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))

# Verify connectivity and SSL before sending 1 MB of data:
docker exec -i -e PGPASSWORD="$env:PGPASSWORD" supabase_db_cues-editorial-cloud `
  psql "$CLOUD" -c "select current_database(), current_user;"

# Hand psql the FILE. Never pipe SQL into it — see the warning below.
docker cp ./load_legacy.sql supabase_db_cues-editorial-cloud:/tmp/load_legacy.sql
docker exec -i -e PGPASSWORD="$env:PGPASSWORD" supabase_db_cues-editorial-cloud `
  psql "$CLOUD" -v ON_ERROR_STOP=1 -f /tmp/load_legacy.sql
docker exec supabase_db_cues-editorial-cloud rm /tmp/load_legacy.sql
```

Expect it to end with `COMMIT`. On any error the whole transaction rolls back
and the cloud database is left untouched — fix and re-run.

> **Never pipe the loader into `psql`.** This step used to read
> `Get-Content ./load_legacy.sql -Raw -Encoding UTF8 | docker exec -i … psql`,
> and **that is how the 2026-07-22 load silently destroyed every non-ASCII
> character in the corpus.** `Get-Content` decoded the file correctly; the pipe
> did not. Windows PowerShell 5.1 re-encodes text on its way into a native
> command using `$OutputEncoding`, which defaults to **ASCII**, and its
> replacement fallback emits a literal `?` for anything it cannot represent —
> one per UTF-16 code unit, so `è` became `?`, an emoji became `??` and a flag
> emoji became `????`. ASCII passed through untouched, so the load reported
> `COMMIT`, every row count reconciled, and nothing looked wrong until somebody
> read the Italian. `docker cp` moves bytes and `psql -f` opens the file itself,
> so neither can re-encode anything.

Check the characters survived, before trusting any of §6's row counts:

```sql
select count(*) filter (where octet_length(post_text) > length(post_text)) as with_accents,
       count(*) filter (where post_text like '%?%')                        as with_question_marks
from raw_posts;
```

`with_accents` must be in the same order as the corpus size — a corpus of real
Italian and multilingual LinkedIn posts that reports **zero** rows containing a
multi-byte character has been flattened to ASCII, whatever the row counts say.
Repairing it afterwards is possible only because the SQLite snapshot is kept;
see `scripts/build_encoding_repair.mjs`.

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

**Keep the step 2.5 record.** The files are reproducible; the timestamp is not.

Next: `docs/first-editor-bootstrap.md`. Until that is done `public.editors` is
empty, and RLS will correctly show every signed-in user zero rows.

---

## Final cutover (Phase 7)

Everything above seeds a development database. This is the operation that makes
the cloud authoritative, and it is **not** a repeat of the above.

By the time you reach it the cloud contains two kinds of data that the legacy
system knows nothing about: posts the new pipeline ingested itself, and
editorial assets that humans have reviewed and approved. Both must survive.
`load_legacy.sql` would erase both. **It is not usable at cutover.** Requirement:

> The Phase 1 loader is single-use. Cutover requires either a write freeze or a
> delta migration. There is no third option that preserves cloud-side work.

### Option A — freeze and final snapshot

Simplest, and appropriate if the cloud pipeline has not yet ingested anything of
its own (i.e. Phase 2 ran only against test sources).

1. Stop the legacy collector so nothing new is written:
   `docker stop cues-editorial-agent-api`
2. Take a final snapshot exactly as in step 1. Note the new timestamp.
3. Confirm the cloud has no pipeline-created rows worth keeping:

   ```sql
   select count(*) from raw_posts where legacy_id is null;          -- new ingests
   select count(*) from editorial_assets where not is_legacy;       -- new assets
   select count(*) from editorial_assets where status <> 'draft';   -- human decisions
   ```

   **If any is non-zero, Option A is off the table.** Use Option B.
4. Regenerate and apply the loader from the final snapshot.
5. Reconcile with step 6, then keep the legacy container stopped but its volume
   intact for at least one full editorial cycle.

The freeze window is minutes, and the legacy system is an internal batch tool
with no live users, so this is usually acceptable.

### Option B — delta migration

Required once the cloud holds any pipeline-created or human-reviewed data.

Write a separate loader that **inserts and updates, never truncates**:

- **New posts** — legacy rows whose `legacy_id` does not already exist in the
  cloud `raw_posts`. Insert them and their `normalized_posts`, `analyzed_posts`
  and `anonymized_posts_current` children, mapping to the new post's uuid.
  Deduplicate against `(source_id, external_post_id)`, since the new pipeline may
  already have ingested the same LinkedIn post independently — that collision is
  the expected case, not an error, and the existing cloud row wins.
- **Changed rows** — `anonymized_posts_current` is overwrite-only and
  `analyzed_posts` may have been re-scored. Compare and update; do not blind
  insert.
- **Legacy assets** — leave them alone. They are already migrated, flagged
  `is_legacy`, and may since have been reviewed.
- **configurations** — do not overwrite. Editors have been editing the cloud row
  through the Objective screen since Phase 6; the legacy row is stale by
  definition.

Run it inside one transaction, reconcile as in step 6, and additionally assert
that pre-existing cloud work is untouched:

```sql
select count(*) from editorial_assets where status <> 'draft';  -- unchanged
select count(*) from raw_posts where legacy_id is null;         -- unchanged
```

### Either way

- Take a cloud backup first — Dashboard → Database → Backups.
- Do the run against a Supabase branch or a throwaway project before production.
- Keep the legacy volume for a full cycle after cutover. It is the only rollback.

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

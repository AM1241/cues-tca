# Phase 1 migration tooling

One-shot scripts for moving the legacy SQLite data into Postgres. They read the
legacy system; they never write to it.

## 1. Snapshot the legacy database

`docker cp` of a live SQLite file can tear mid-write. Use the SQLite Online
Backup API instead, which holds a read lock and produces a transactionally
consistent copy even while the FastAPI process is running:

```bash
docker cp scripts/snapshot_legacy.py cues-editorial-agent-api:/tmp/snapshot.py
docker exec cues-editorial-agent-api python /tmp/snapshot.py
docker cp cues-editorial-agent-api:/tmp/legacy_snapshot.db ./legacy_snapshot.db
```

It prints `integrity_check` and `foreign_key_check` results — both must be clean
before the snapshot is used for anything.

## 2. Generate the loader

```bash
node scripts/build_legacy_loader.mjs legacy_snapshot.db load_legacy.sql
```

Emits one transactional SQL script. What it does beyond a straight copy:

- **raw_posts** get surrogate `uuid` PKs; the legacy composite key is preserved
  in `legacy_id` so the traceability mapping still resolves.
- **traceability_links.source_post_ids** — a JSON array with no referential
  integrity — is expanded into `traceability_link_posts` rows with real FKs.
- **editorial_assets** are all marked `is_legacy = true`, and classified:
  `simulated_fallback` where the text carries the legacy `_simulated_llm`
  signature, `legacy_unverified` otherwise. `llm_used` is `false` for the former
  and `NULL` for the latter — never inferred.
- `content_hash` is a generated column and is not inserted.

Apply it:

```bash
psql "$DB_URL" -v ON_ERROR_STOP=1 -f load_legacy.sql
```

The script truncates its target tables first, so it is safe to re-run.

## 3. Verify RLS

```bash
psql "$DB_URL" -f scripts/verify_rls.sql
```

Runs the whole access matrix — anon, authenticated-but-not-allowlisted,
allowlisted editor, service_role — inside a transaction that always rolls back.
Expected: anon denied everywhere, outsider reads zero rows, editor reads all and
writes only sources/config/asset-review, service_role does everything.

## Expected row counts

| table | rows |
|---|---|
| sources | 4 |
| raw_posts | 133 |
| normalized_posts | 133 |
| analyzed_posts | 133 |
| anonymized_posts_current | 30 |
| generation_requests | 15 |
| editorial_assets | 15 (9 `simulated_fallback`, 6 `legacy_unverified`) |
| traceability_links | 89 |
| traceability_link_posts | 469 |
| configurations | 1 |

`legacy_snapshot.db` and `load_legacy.sql` are gitignored — they hold real post
content and are reproducible from the commands above.

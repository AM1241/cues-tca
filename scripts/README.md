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

> **The loader TRUNCATES before loading. It is safe to re-run only while the
> target database holds nothing but legacy data.** Against a local stack that is
> always true — `db reset` wipes it anyway. Against the cloud it is true exactly
> once, before Phase 2's first real ingest. After that, re-running it destroys
> every post, score, anonymisation and reviewed asset the new pipeline produced.
> Final cutover uses a delta migration instead; see
> `docs/cloud-migration-runbook.md`.

`snapshot_legacy.py` prints `snapshot_taken_at_utc:`. Record it — it is the
delta boundary for that eventual cutover, and it is not recoverable afterwards.

Since 0003, the loader's `truncate ... cascade` on `sources` also clears
`ingest_run_sources` and `raw_post_content_changes`. Locally that is harmless;
in the cloud it is one more reason the loader is single-use.

## 3. Verify

```bash
psql "$DB_URL" -f scripts/verify_rls.sql      # Phase 1 access matrix
psql "$DB_URL" -f scripts/verify_ingest.sql   # Phase 2 privileges, locking, finalizer
```

Both roll back everything they do. Phase 2 unit tests need no database:

```bash
docker run --rm -v "$PWD/supabase/functions:/app" -w /app denoland/deno:alpine-2.5.2 \
  deno test --allow-env --allow-net=jsr.io ingest/__tests__/
```

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

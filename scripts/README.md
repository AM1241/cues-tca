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

`-f`, giving psql the file, is not incidental. Piping this script into psql from
PowerShell is what flattened the cloud corpus to ASCII on 2026-07-22 — see the
warning in §5 of `docs/cloud-migration-runbook.md`, and step 2b below.

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

## 2b. Repair the 2026-07-22 encoding damage

The cloud load was piped into psql from PowerShell, which re-encoded it as ASCII
and replaced every character it could not represent with a literal `?`. The
loader and the snapshot were both fine; only the applied result was damaged.
`build_encoding_repair.mjs` restores it from the same snapshot:

```bash
node scripts/build_encoding_repair.mjs legacy_snapshot.db repair_encoding.sql
psql "$DB_URL" -v ON_ERROR_STOP=1 -f repair_encoding.sql
```

Unlike the loader this is **not** single-use and truncates nothing. Every
statement is guarded on the md5 of the damaged text, so it is idempotent, inert
against a value that is not in the exact expected damaged state, and a complete
no-op against a database that was loaded correctly.

Expected against `bxaovkzemfyxrxbcqask` as of 2026-09-03 — 328 statements:

| table.column | values |
|---|---|
| raw_posts.post_text | 132 |
| raw_posts.author | 46 |
| normalized_posts.clean_text | 132 |
| editorial_assets.generated_text | 15 |
| traceability_links.claim_text | 3 |

It repairs stored text only. `anonymize_results`, `post_embeddings`,
`scoring_results` and the clusters built on them were produced by models reading
the damaged text; correcting those means re-running the pipeline, which costs
LLM calls and is an operator decision. See `docs/SESSION_HANDOFF.md`.

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

Handler tests additionally need the local stack (`--network` plus the keys from
`supabase status`, and `INGEST_INTERNAL_SECRET`). They call `handleIngest()`
directly, so they exercise the logic but **not** the platform gateway.

## 4. Gateway verification

The gateway is a separate boundary, and it is where `verify_jwt` would reject
the opaque internal secret before any of our code ran. Test it over real HTTP:

```bash
cp supabase/functions/.env.example supabase/functions/.env.test   # set a real secret
npx supabase functions serve ingest --env-file supabase/functions/.env.test --no-verify-jwt

# in another shell, with SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY /
# INGEST_INTERNAL_SECRET exported:
node scripts/verify_gateway.mjs
```

Every accepted request targets a source with no `rapidapi_identifier`, so the
runs finish with skips and **zero** outbound HTTP. `RAPIDAPI_KEY` is a dummy in
`.env.test` so a real provider call would fail loudly rather than succeed.

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

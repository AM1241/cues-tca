# Phase 1 completion record

Schema, auth, RLS and the legacy data load, applied to the cloud project
`bxaovkzemfyxrxbcqask` (`cues-tca`, eu-west-1, Postgres 17.6).

## Status

**Complete.** The cloud database holds the Phase 1 schema and a seed load of the
legacy data.

> **This load is a development/test seed, not the production cutover.** The
> legacy application (`cues-editorial-agent-api`) and its Docker volume remain
> untouched and authoritative until Phase 7 is signed off.

## Delta boundary

```text
snapshot_taken_at_utc : 2026-07-22T02:17:11.788315+00:00
```

Everything created or modified in the legacy system after that instant is **not**
in the cloud. It is the reference point for the eventual cutover delta and cannot
be reconstructed later — the snapshot and loader files were deleted after the
load, by design, as they contain real post content.

Legacy ingestion is manual (`POST /api/collection/run` is a stub), so the legacy
database does not grow on its own. The delta will stay empty unless someone runs
the connector by hand before cutover.

## Migrated counts

Snapshot source counts, all matched exactly in the cloud after loading:

| table | rows |
|---|---|
| `sources` | 4 |
| `raw_posts` | 133 |
| `normalized_posts` | 133 |
| `analyzed_posts` | 133 |
| `anonymized_posts_current` | 30 |
| `generation_requests` | 15 |
| `editorial_assets` | 15 |
| `traceability_links` | 89 |
| `traceability_link_posts` | 469 |
| `configurations` | 1 |

Not migrated, by design: `clusters` (0 rows, all `cluster_id` NULL, clustering is
stateless) and `analyzed_posts_backup_before_mock_llm` (one-off manual backup
whose per-theme scores are mostly zeros — the fossil of the bare-integer batch
prompt bug, superseded by the live table).

Loader summary:

```text
external_post_id recovered 132 / null 1     (the one 'manual' source_url)
link_post_refs 469   unresolved 0
provenance: simulated_fallback 9   legacy_unverified 6
```

## Cloud verification

| Check | Result |
|---|---|
| Migration history | `0001_schema.sql`, `0002_auth_rls.sql` both recorded |
| Tables | all 11 present |
| RLS | enabled on all 11 |
| Data load | transactional, ended `COMMIT` |
| Row counts | match the snapshot exactly |
| Orphan checks (8 FK paths) | all 0 |
| Duplicate checks | all 0 |
| Provenance | 9 `simulated_fallback`/`llm_used=false`, 6 `legacy_unverified`/`llm_used=NULL` |
| Traceability | 469 references across 89 links, all resolve |
| First editor | Auth user created and added to `public.editors` as `admin` |

## Schema decisions worth remembering

**Post identity is the provider's id, not the text.** `MIGRATION_PLAN.md`
originally called for `UNIQUE (source_id, content_hash)`. That would have
re-created the bug it was meant to fix — a company reposting identical copy at a
new URL is a distinct post. Identity is `(source_id, external_post_id)`, the
LinkedIn activity URN, partial-unique where not null. `content_hash` is indexed
for duplicate *detection*; `canonical_url` is indexed but not unique, because the
URL slug is derived from the post text and changes when a post is edited.

**Deletion is restricted, not cascading.** `raw_posts.source_id` and
`traceability_link_posts.raw_post_id` are `ON DELETE RESTRICT`. Sources are
retired with `enabled = false`. A post cited by an approved asset is audit
evidence and cannot be removed out from under it.

**Grants matter as much as policies.** This Postgres grants no DML by default, so
RLS policies alone are unreachable and `service_role` cannot write. Separately,
`authenticated` held `TRUNCATE` on every table — which RLS does not filter and no
policy can stop. Both are handled in `0002`.

**Provenance is explicit and constrained.** `llm_used` is nullable and NULL means
unknown. A check constraint ties it to `provenance`, so no row can claim
knowledge it has not earned. Editors hold column-level UPDATE on review fields
only; `provenance`, `llm_used`, `is_legacy`, `generation_id` and `created_at` are
service-role-only.

## Known follow-up

7 of the 133 `analyzed_posts` have `overall_relevance = 0` while every per-theme
score is non-zero. Migrated unchanged, deliberately. Whatever wrote
`overall_relevance` disagreed with the per-theme values; Phase 3 should establish
which is authoritative.

```sql
select count(*) from analyzed_posts where overall_relevance = 0;  -- 7
```

## Commits

| Hash | Description |
|---|---|
| `62e63c7` | Phase 0: project scaffold |
| `e15d577` | Disable local analytics container |
| `08b340e` | Phase 1: schema, auth and RLS (local only) |
| `b9a8f5e` | Phase 1 corrections: source deletion, post identity, asset column privileges |
| `d211649` | Fix flaky local stack exit code; add cloud runbook and editor bootstrap |
| `b1062a6` | Docs: cutover boundary, exact pooler string, key placeholder, storage scope |

## Local environment notes

`analytics`, `storage` and `studio` are disabled in `supabase/config.toml`.
Analytics needs the Docker daemon on `tcp://localhost:2375` on Windows; storage
and studio ship healthchecks with no `start_period`, so on this host the first
probe fires before the service binds its port and the CLI aborts with exit 1
despite a healthy database. **Storage must be re-enabled before any
storage-dependent work — including the optional OpenAI Batch path in Phase 3, not
only Phase 7.**

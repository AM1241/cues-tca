# Legacy system reference

The system being replaced: `../cues-tca-editorial-agent`. FastAPI + SQLAlchemy + SQLite,
run in Docker on `localhost:8001` (container port 8000). ~4,300 lines of Python.

Read this before porting a stage. It records what the old code actually does — including
the parts that are broken or dead — so the rewrite doesn't inherit them.

## Where the real data is

Not in the repo. `backend/data/posts.db` in the working tree is stale and empty, and is
missing the `anonymized_posts_current` table entirely. The live data is in the
`cues_backend_data` Docker volume:

| table | rows |
|---|---|
| `raw_posts` | 133 |
| `normalized_posts` | 133 |
| `analyzed_posts` | 133 (+ a `analyzed_posts_backup_before_mock_llm` copy) |
| `anonymized_posts_current` | 30 |
| `sources` | 4 |
| `generation_requests` | 15 |
| `editorial_assets` | 15 |
| `traceability_links` | 89 |
| `clusters` | 0 |
| `configurations` | 1 |

Export it with:

```bash
docker exec cues-editorial-agent-api sqlite3 /app/backend/data/posts.db .dump > legacy_dump.sql
```

`clusters` being empty is not a bug — clustering was reimplemented as a stateless
computation (`ObjectiveClusteringService`) that never writes rows. The `Cluster` table and
`AnalysisService.cluster_posts` are leftovers from the first design.

## Data model

Nine tables in `backend/app/models/db.py`. The chain that matters:

- `sources` — one row per LinkedIn company page. `id` is a string.
- `raw_posts` — ingested posts. **Primary key is `f"{source_type}_{source_name}_{md5(post_text)}"`**,
  but deduplication is checked on `(source_id, source_url)`. Two different URLs with identical
  text from one source therefore collide on the primary key and raise.
- `normalized_posts` — cleaned text, hashtags, mentions, word count, a naive `tone_type`.
  1:1 with `raw_posts`.
- `analyzed_posts` — `overall_relevance` (0–100), per-theme `relevance_scores` JSON,
  `reason_for_score`, `included_in_generation`.
- `anonymized_posts_current` — **overwrite-only, no history.** PK is `raw_post_id`. Holds the
  anonymised text, the list of replacements made, and a snapshot of the config used.
- `generation_requests` / `editorial_assets` / `traceability_links` — outputs.
- `configurations` — a single `id='default'` row holding themes, voice, aliases, threshold.

Every timestamp is naive `datetime.utcnow()`. Every id is a string UUID except `raw_posts`.

## Stage by stage

### 1. Ingest

`connector_rapidapi_to_cues.py` + `backend/app/connectors/linkedin_rapidapi.py`. Shells out
via `subprocess` to a **sibling repo**, `../linkedin_rapidapi_scraper`, pointing it at a
per-company SQLite file, reads that file back, then POSTs each post to its own API over
HTTP (`POST /api/collection/manual`). Companies are listed in `connector_config.json`
(GBfoods Italy, Fratelli Branca, MASAF, European Commission) with a `lookback_days` window.

`POST /api/collection/run` is a stub that returns a TODO string. Ingestion is manual.

**Do not port this shape.** It only exists because the scraper was a separate project. The
replacement calls the RapidAPI LinkedIn endpoint directly and inserts into Postgres.

### 2. Scoring

Two independent implementations, and the docs disagree about which is live:

- `AnalysisService.score_relevance` — keyword counting, 15 points per keyword hit, capped at
  100, averaged over themes. Wired into `POST /api/analysis/process-pipeline`. Returns early
  if the post already has an `analyzed_posts` row, so re-scoring needs a manual delete.
- `BatchScoringService` in `services/batch_scoring_service.py` — the real path. Writes a JSONL
  batch file (Anthropic `/v1/messages` shape) via `POST /api/analysis/batch/build`, the
  operator runs it at the provider by hand, then `POST /api/analysis/batch/apply?results_path=…`
  parses it back. The prompt asks for **a bare integer**, so per-theme scores are lost —
  `apply_scores` writes `{theme: 0.0}` for every theme, which then starves the clustering
  stage that buckets posts by highest per-theme score.
- `services/llm_batch_scoring_service.py` — **dead code.** Same class name `BatchScoringService`,
  incompatible OpenAI `/v1/chat/completions` shape, different method names, richer prompt that
  does return per-theme scores and a reason. Nothing imports it. Its prompt is worth salvaging;
  its plumbing is not.

The manual out-of-band batch step is the biggest operational cost in the old system.

### 3. Anonymisation

`services/anonymization_service.py`, deterministic regex, no LLM. Builds a replacement map
from **source names only** — it never scans post text for company names it doesn't already
know about. Public bodies (EU, EFSA, FAO, WHO…) are preserved by a hardcoded term list.
Unknown organisations fall back to generic phrases like "a food-sector organization".
Optionally buckets percentages and large numbers into ranges.

`preview` and `apply` share one code path; `apply` upserts into `anonymized_posts_current`.

Known gap: entity coverage depends entirely on the source name matching the text. Worth
adding an LLM entity pass in the rewrite, but keep the deterministic replacement — auditors
need the `replacements` list.

### 4. Clustering

`services/objective_clustering_service.py`. Not embeddings. Each post is assigned to the
theme with its highest per-theme score; buckets below `min_cluster_size` are dropped; the
remaining buckets are ranked by average relevance plus a token-overlap "objective alignment"
term. Cluster names come from a one-shot LLM call (or a `"{Theme} Focus"` fallback).

Given that batch scoring writes zeros for every theme, this stage usually falls through to
its single "Objective Context" fallback cluster in practice. pgvector + a real clustering
step is the intended fix.

### 5. Generation

`services/llm_editorial_generation_service.py`, the most complete part of the system.
Queries `anonymized_posts_current` joined to `raw_posts` for the date window, builds cluster
evidence, assembles a prompt from the editorial brief + voice + evidence, calls the LLM, and
writes an `editorial_assets` row plus `traceability_links`.

Two things to carry over carefully:

- **The silent fallback.** `_call_real_llm` wraps everything in bare `except: pass` and
  returns `None`; the caller then substitutes `_simulated_llm`, ~160 lines of hardcoded
  editorial copy about "the food industry is not a stereotype". The response's `llm_used`
  flag is the only way to tell real output from canned. This has almost certainly polluted
  some of the 15 stored assets. Keep a fallback if you want, but make it loud.
- **The prompt and output formats** (`post`, `carousel`, `post+carousel`, `newsletter`) are
  good and should be ported close to verbatim.

Titles and hashtags are extracted from the model's markdown by regex (`**bold**`, `#\w+`) —
brittle. Use structured output in the rewrite.

### 6. Review and export

`api/review.py` and `api/export.py` are stubs returning `"not yet implemented"`. The DB
columns exist (`status`, `approved_by`, `approval_timestamp`, `feedback_provided`) but
nothing writes them. Every asset in the database is `status='draft'`. This is net-new work,
not a port.

## Bugs and hazards, condensed

- `CollectionService.get_collection_stats` builds `RawPost.__table__.c.count()` — invalid,
  raises on call. `GET /api/collection/stats` is broken.
- `main.py` exception handlers return plain dicts instead of `Response` objects; FastAPI
  will error while handling the error.
- `CORSMiddleware` uses `allow_origins=["*"]` together with `allow_credentials=True`, a
  combination browsers reject. There is no authentication anywhere in the app.
- `init_db()` runs at module import in `main.py`.
- `raw_posts` PK collision described above.
- `.env` in the legacy repo contains a live `OPENAI_API_KEY`. It is gitignored; when
  migrating, rotate the key rather than copying it forward.
- `frontend/` and `crawlers/` are empty directories. `backend/tests/` contains only
  `__init__.py` — there are no tests. The legacy repo is not under git.
- `README.md` documents a project structure that does not match the code (`review_service.py`,
  `export_service.py`, `utils/llm_client.py`, `backend/config/rules.json` — none exist).
  Trust the code, not that README.

## Documents worth keeping

- `README_CUSTOM_OBJECTIVE_SIMPLE.md` (Greek) — the operator workflow, the clearest statement
  of how the config-driven objective is meant to be used.
- `docs/cues_objective_brief_example.md` — the editorial brief text; copied to
  `docs/editorial-brief.md` here.
- `WORKPLAN.md`, `IMPLEMENTATION_SUMMARY.md`, `PROGRESS.md` — historical, describe an
  earlier plan that the code diverged from. Low value.

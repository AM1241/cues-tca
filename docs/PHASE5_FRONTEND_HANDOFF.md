# Phase 5 frontend handoff — cluster-based editorial generation

This is the contract for the `generate` Edge Function and its tables. You
should not need to read `supabase/functions/generate/*.ts` or
`supabase/migrations/0016_generation.sql` to build against this — everything
you need is below.

## Endpoint

```
POST {SUPABASE_URL}/functions/v1/generate
```

Auth: send the logged-in user's access token as `Authorization: Bearer <token>`
(same pattern as `cluster`/`ingest`). The caller must be on the `editors`
allowlist. There is also an internal-secret path (`apikey` header) for
programmatic/non-browser callers — not relevant to the frontend.

CORS: your origin must be present in the function's `ALLOWED_ORIGINS`
(already the case for local dev — see `CLAUDE.md`).

## Request schema

```json
{
  "clustering_run_id": "<uuid>",
  "cluster_ids": ["<uuid>", "..."],
  "output_types": ["post", "carousel"]
}
```

- `clustering_run_id` — required. Must reference a `clustering_runs` row with
  `status = 'completed'`.
- `cluster_ids` — required, non-empty array of `clusters.id` values. Every
  cluster must belong to the given `clustering_run_id`; a cluster from a
  different run is rejected for the whole request before anything is
  attempted.
- `output_types` — optional, defaults to `["post", "carousel"]`. Only
  `"post"` and `"carousel"` are valid values (no `"newsletter"`, no
  `"post+carousel"` — those are legacy Phase-0 sketch values that Phase 5
  does not implement).

Only clusters with `clusters.label_failed = false` are eligible — a
`label_failed` cluster in your selection is rejected with a per-cluster error
(see below), not silently skipped and not force-generated with a placeholder
label.

## Success response

`200`, `ok: true`. One entry in `results` per cluster that generated
successfully. **A request only reaches `ok: true` if every requested cluster
succeeded** — see "Partial failure" below for the alternative.

```json
{
  "ok": true,
  "generation_request_id": "5e2f9e0a-...",
  "results": [
    {
      "generation_result_id": "a1b2c3d4-...",
      "cluster_id": "9f8e7d6c-...",
      "cluster_label": "Sustainability and circular economy",
      "post": {
        "headline": "string",
        "text": "string",
        "cta": "string",
        "hashtags": ["#string", "..."]
      },
      "carousel": {
        "title": "string",
        "slides": [
          { "position": 1, "heading": "string", "body": "string" },
          { "position": 2, "heading": "string", "body": "string" },
          { "position": 3, "heading": "string", "body": "string" },
          { "position": 4, "heading": "string", "body": "string" },
          { "position": 5, "heading": "string", "body": "string" }
        ],
        "caption": "string",
        "cta": "string"
      }
    }
  ]
}
```

If `output_types` omitted `"carousel"` (or `"post"`), that key is simply
absent from each result object — never present-but-null.

Carousel `slides` is always exactly 5 entries, `position` 1–5 in order:

1. Opening/title slide
2. Context/problem slide
3. Main insight slide
4. Evidence/implication slide
5. Closing/CTA slide

## Error responses

**Upfront validation errors** — non-2xx, nothing was created:

| Status | Cause |
|---|---|
| 400 | Malformed body — missing/empty `cluster_ids`, invalid `output_types`, non-string `clustering_run_id` |
| 401 | Missing/invalid credentials |
| 403 | Authenticated but not an allowlisted editor |
| 404 | `clustering_run_id` not found, or a `cluster_id` not found at all |
| 422 | The run exists but `status != 'completed'`, or a `cluster_id` exists but belongs to a **different** run |
| 500 | Server misconfiguration (e.g. `OPENAI_API_KEY` not set) |

```json
{ "ok": false, "error": "clustering_run <id> is not completed (status=running)." }
```

**Partial/total failure during generation** — `200`, `ok: false`. A request
row *was* created; some or all requested clusters failed. Never fabricated
output — a failed cluster simply has no entry in `results`.

```json
{
  "ok": false,
  "generation_request_id": "5e2f9e0a-...",
  "error": "1 of 2 requested cluster(s) failed to generate.",
  "results": [ /* successful clusters only, same shape as above */ ],
  "errors": [
    { "cluster_id": "...", "error_type": "llm_rate_limit", "error_message": "..." }
  ]
}
```

`error_type` values you may see: `label_failed`, `no_valid_input`,
`llm_refusal` / `llm_incomplete` / `llm_content_filter` / `llm_empty_output` /
`llm_invalid_json` / `llm_schema_mismatch` / `llm_rate_limit` /
`llm_server_error` / `llm_network` / `llm_timeout` / `llm_client_error`,
`schema_error`, `persistence_error`.

## Tables

All three are readable by any allowlisted editor (RLS `SELECT` only — the
frontend never writes to them directly; only the `generate` function does,
via `service_role`).

### `cluster_generation_requests`

One row per call to `generate`. Immutable except `status`/`error_message`/
`completed_at`.

| Column | Notes |
|---|---|
| `id` | = the response's `generation_request_id` |
| `clustering_run_id` | the run this request operated on |
| `requested_cluster_ids` | `uuid[]` — exactly what was asked for |
| `output_types` | `text[]` — `post` and/or `carousel` |
| `status` | `pending` \| `completed` \| `failed` — see below |
| `error_message` | set only when `status = 'failed'` |
| `created_by` | the editor who triggered it (null for internal-secret calls) |
| `created_at`, `completed_at` | |

**Status meanings:**
- `pending` — should not normally be visible to the frontend; `generate` is
  synchronous and the HTTP response only returns after the request reaches
  a terminal status. A row stuck at `pending` means the function crashed
  mid-request (e.g. a container restart) — treat as failed for display
  purposes, there is no resume/retry.
- `completed` — every requested cluster produced a result. There is **no
  partial-success status** — if even one cluster failed, the whole request
  is `failed`, even though other clusters in it may have real results in
  `cluster_generation_results`.
- `failed` — at least one requested cluster did not produce a result. Check
  `cluster_generation_request_errors` for which cluster(s) and why.

### `cluster_generation_request_errors`

One row per cluster that failed within a request.

| Column | Notes |
|---|---|
| `generation_request_id` | FK to the request |
| `cluster_id` | which cluster failed |
| `error_type`, `error_message` | see the error_type list above |

### `cluster_generation_results`

Append-only (DB-enforced — `UPDATE`/`DELETE` both raise). One row per
cluster that generated successfully, ever. **There is no "current" pointer
and no overwrite** — a re-generation of the same cluster is a brand-new row
under a new `generation_request_id`.

| Column | Notes |
|---|---|
| `id` | = the response's `generation_result_id` |
| `generation_request_id` | which request produced this |
| `clustering_run_id`, `cluster_id` | |
| `cluster_label` | snapshot of the cluster's label at generation time |
| `raw_post_ids` | `uuid[]` — exact traceability: the posts this result was generated from |
| `anonymize_result_ids` | `uuid[]` — exact `anonymize_results.id` values whose text was used (not "whatever `anonymized_posts_current` says now") |
| `output_types` | what was requested for this specific result |
| `post_output`, `carousel_output` | `jsonb`, same shape as the HTTP response's `post`/`carousel` — null if that type wasn't requested |
| `config_snapshot` | `{ themes, voice_tone, voice_audience, voice_style }` as they stood at generation time |
| `prompt_version` | currently `"generate_v1"` |
| `prompt_hash` | SHA-256 of the exact rendered prompt text sent to the model |
| `model` | the OpenAI model actually used |
| `provider_response` | raw OpenAI response body, for audit/debugging |
| `created_at` | |

## How to list completed generation requests

```ts
const { data } = await supabase
  .from('cluster_generation_requests')
  .select('id, clustering_run_id, requested_cluster_ids, output_types, status, error_message, created_at, completed_at')
  .order('created_at', { ascending: false });
```

Filter `status` client-side, or with `.eq('status', 'completed')` /
`.eq('status', 'failed')`.

## How to fetch results by request and cluster

```ts
// All results for one request:
const { data } = await supabase
  .from('cluster_generation_results')
  .select('*')
  .eq('generation_request_id', requestId);

// All generations ever produced for one cluster (across multiple requests —
// e.g. to show generation history for a cluster):
const { data } = await supabase
  .from('cluster_generation_results')
  .select('*')
  .eq('cluster_id', clusterId)
  .order('created_at', { ascending: false });

// Errors for a request (to explain a status='failed' request):
const { data } = await supabase
  .from('cluster_generation_request_errors')
  .select('cluster_id, error_type, error_message')
  .eq('generation_request_id', requestId);
```

## How to render post and carousel outputs

`post_output` / `carousel_output` (or the HTTP response's `post`/`carousel`)
are already-structured JSON — no markdown parsing needed:

- **Post**: render `headline` as a title, `text` as the body (it may contain
  `\n` paragraph breaks — preserve them), `cta` as a call-to-action line,
  `hashtags` as a tag list or appended to the post text.
- **Carousel**: render `title` once, then iterate `slides` in `position`
  order (always 1–5) showing `heading` + `body` per slide, then `caption`
  and `cta` for the accompanying post copy that goes with the carousel.

## Traceability fields

To answer "which raw posts, through which anonymisation and clustering
steps, produced this generation":

```
cluster_generation_results.raw_post_ids        -> raw_posts.id
cluster_generation_results.anonymize_result_ids -> anonymize_results.id
cluster_generation_results.cluster_id           -> clusters.id
cluster_generation_results.clustering_run_id    -> clustering_runs.id
```

All four are exact snapshots taken at generation time — they do not drift if
a post is later re-anonymised or re-clustered under a new run. To show the
actual anonymised text a result was generated from (not necessarily what
`anonymized_posts_current` shows today):

```ts
const { data } = await supabase
  .from('anonymize_results')
  .select('id, raw_post_id, anonymized_text, generalized_source_name')
  .in('id', result.anonymize_result_ids);
```

## Frontend integration checklist

- [ ] A "Generate" action on the Clusters view: let the editor pick a
      completed `clustering_run_id` and one or more of its clusters
      (excluding any with `label_failed = true` — grey these out, don't let
      them be selected, since the backend will reject them anyway).
- [ ] Call `generate` synchronously (it blocks until done — expect several
      seconds per selected cluster; show a spinner, no polling needed).
- [ ] On `ok: true`, show each result's post + carousel immediately from the
      response — no need to re-fetch.
- [ ] On `ok: false` with a `generation_request_id` present, show which
      clusters succeeded (`results`) and which failed (`errors`) — this is a
      partial-failure state, not a total failure; some real output may exist.
- [ ] On `ok: false` with no `generation_request_id` (upfront validation
      error, e.g. 422/404), show the top-line `error` message only.
- [ ] A "Generation history" view reading `cluster_generation_requests` +
      `cluster_generation_results` by `created_at desc` — there is no
      approve/edit workflow yet (see limitations), so this is read-only
      display for now.
- [ ] Do not attempt to call `generate` for clusters from an incomplete or
      failed `clustering_runs` row — the backend rejects this, but the UI
      should not offer it as an option in the first place.

## Known Phase 5 limitations

- **No approve/edit/regenerate workflow.** Generation results are
  read-only, immutable rows. There is no status field to mark a result
  "approved," no edit surface, and no "regenerate with feedback" — a
  re-generation is just calling `generate` again, which produces an
  entirely new, unrelated result row.
- **No unclustered-post generation.** Only posts that landed in a real
  cluster (`cluster_assignments`) are eligible. Posts in `cluster`'s
  `unclustered` bucket are not persisted as a pseudo-cluster and cannot be
  generated from, individually or otherwise.
- **No automated scheduling.** `generate` is synchronous and on-demand only
  — there is no cron, no background queue, and no auto-triggering after a
  clustering run completes. An editor must explicitly select clusters and
  invoke it.

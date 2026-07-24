/**
 * POST /functions/v1/cluster
 *
 *   { "period_start": "2026-01-01T00:00:00Z", "period_end": "2026-02-01T00:00:00Z" }
 *
 * On-demand, recompute-all clustering over one editorial batch (a caller-
 * specified date window) — see PHASE4_REQUIREMENTS.md §3. Flow:
 *
 *   1. Fetch eligible anonymised posts (relevance + period, from
 *      anonymized_posts_current), each carrying the exact anonymize_result_id
 *      its current text came from.
 *   2. create_clustering_run() — a real 'running' row exists before any
 *      embedding/labeling work happens.
 *   3. record_clustering_run_input() — the exact (raw_post_id,
 *      anonymize_result_id) pairs this run operates over, recorded up front.
 *   4. Reuse existing post_embeddings rows (keyed by anonymize_result_id +
 *      model); embed only posts missing one. A post whose current
 *      anonymisation or the embedding model changed has no matching row and
 *      is re-embedded automatically.
 *   5. Group by cosine similarity in TypeScript (grouping.ts, internally
 *      sorted for determinism), applying configurations.cluster_similarity_
 *      threshold / min_cluster_size.
 *   6. One LLM call per resulting cluster to generate its label. A failed
 *      label call marks that cluster label_failed=true — never a fabricated
 *      "Untitled cluster" presented as success.
 *   7. complete_clustering_run() persists clusters/assignments and marks the
 *      run 'completed' — but ONLY if at least one post was actually embedded.
 *      If every eligible post's embedding failed, the run is marked 'failed'
 *      via fail_clustering_run() instead; it never reports completed with
 *      zero real clustering work behind it.
 *
 * Dual auth (internal secret OR an editor), same as ingest — this is more
 * likely triggered from the frontend's date-range picker than by a queue.
 *
 * Failure handling: zero ELIGIBLE posts (nothing to cluster in the window at
 * all) is a clean empty result with no run row — an honest "there was
 * nothing to do" rather than a failure. Zero SUCCESSFULLY EMBEDDED posts out
 * of a non-empty eligible set is a failed run — real input existed and the
 * pipeline could not process any of it. A single post's embedding failure
 * excludes that post from the run with a visible warning, as long as enough
 * posts remain to proceed.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { RequestError } from "../_shared/errors.ts";
import { callEmbedding, EmbeddingError } from "../_shared/embeddings.ts";
import { callOpenAi, OpenAiError, type CallOpenAiOptions } from "../_shared/openai.ts";
import { groupBySimilarity, type EmbeddedPost } from "./grouping.ts";
import { buildClusterLabelPrompt, buildClusterLabelSchema } from "./prompt.ts";
import {
  completeClusteringRun,
  createClusteringRun,
  failClusteringRun,
  getConfig,
  getEligiblePosts,
  getExistingEmbeddings,
  recordClusteringRunInput,
  recordEmbeddingOutcome,
  upsertEmbedding,
  type ClusterInput,
} from "./data.ts";

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_LABEL_MODEL = "gpt-5.4-nano-2026-03-17";

export interface ClusterDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  callEmbeddingImpl?: typeof callEmbedding;
  callOpenAiImpl?: typeof callOpenAi;
}

interface ClusterRequestBody {
  period_start: string;
  period_end: string;
}

function parseBody(body: Record<string, unknown>): ClusterRequestBody {
  const start = body.period_start;
  const end = body.period_end;
  if (typeof start !== "string" || typeof end !== "string") {
    throw new RequestError(400, "period_start and period_end are required ISO timestamps.");
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new RequestError(400, "period_start and period_end must be valid timestamps.");
  }
  if (endDate < startDate) {
    throw new RequestError(400, "period_end must not be before period_start.");
  }
  return { period_start: startDate.toISOString(), period_end: endDate.toISOString() };
}

export async function handleCluster(req: Request, deps: ClusterDeps = {}): Promise<Response> {
  const origin = req.headers.get("Origin");

  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405, origin);
  }

  try {
    let body: unknown = {};
    const rawBody = await req.text();
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new RequestError(400, "Body is not valid JSON.");
      }
    }

    // Dual auth like ingest: an admin editor from the frontend, or the
    // internal secret for programmatic triggering. No restriction to one kind.
    await authenticate(req, body as Record<string, unknown>);

    const { period_start, period_end } = parseBody(body as Record<string, unknown>);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");

    const embedModel = Deno.env.get("CLUSTER_EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL;
    const labelModel = Deno.env.get("CLUSTER_LABEL_MODEL") ?? DEFAULT_LABEL_MODEL;
    const callEmbed = deps.callEmbeddingImpl ?? callEmbedding;
    const callLlm = deps.callOpenAiImpl ?? callOpenAi;

    const db = deps.db ?? serviceClient();
    const config = await getConfig(db);

    const eligible = await getEligiblePosts(db, period_start, period_end, config.min_relevance_score);

    if (eligible.length === 0) {
      // Nothing to do at all — no run row, this is not a failure.
      return jsonResponse({
        ok: true,
        run_id: null,
        period_start, period_end,
        totals: { eligible: 0, embedded: 0, embedding_failed: 0, clusters: 0, unclustered: 0 },
        clusters: [],
      }, 200, origin);
    }

    // Phase 1: a real 'running' row exists before any embedding/labeling work.
    const runId = await createClusteringRun(db, {
      periodStart: period_start,
      periodEnd: period_end,
      minRelevanceScore: config.min_relevance_score,
      clusterSimilarityThreshold: Number(config.cluster_similarity_threshold),
      minClusterSize: config.min_cluster_size,
      embeddingModel: embedModel,
    });

    // Record the exact input set — (raw_post_id, anonymize_result_id) pairs —
    // before embedding/clustering, so the attempt is on record regardless of
    // what happens next.
    await recordClusteringRunInput(
      db, runId,
      eligible.map((p) => ({ rawPostId: p.raw_post_id, anonymizeResultId: p.anonymize_result_id })),
    );

    // Step: reuse existing embeddings (keyed by anonymize_result_id + model),
    // embed only posts missing one.
    const existing = await getExistingEmbeddings(db, eligible.map((p) => p.anonymize_result_id), embedModel);
    const embedded: (EmbeddedPost & { anonymizeResultId: string })[] = [];
    const embeddingWarnings: { raw_post_id: string; error: string }[] = [];

    for (const post of eligible) {
      const cached = existing.get(post.anonymize_result_id);
      if (cached) {
        // A cache hit is still a real embedding for this run's model — mark
        // it 'embedded' in the run's own per-post audit, not just implicitly
        // via absence of a failure.
        await recordEmbeddingOutcome(db, runId, post.raw_post_id, "embedded");
        embedded.push({ rawPostId: post.raw_post_id, anonymizeResultId: post.anonymize_result_id, embedding: cached });
        continue;
      }
      try {
        const vec = await callEmbed({ apiKey, model: embedModel, input: post.anonymized_text, fetchImpl: deps.fetchImpl });
        await upsertEmbedding(db, post.anonymize_result_id, post.raw_post_id, vec, embedModel);
        await recordEmbeddingOutcome(db, runId, post.raw_post_id, "embedded");
        embedded.push({ rawPostId: post.raw_post_id, anonymizeResultId: post.anonymize_result_id, embedding: vec });
      } catch (e) {
        const ee = e instanceof EmbeddingError ? e : null;
        const message = ee?.message ?? (e as Error).message;
        await recordEmbeddingOutcome(db, runId, post.raw_post_id, "failed", message);
        embeddingWarnings.push({ raw_post_id: post.raw_post_id, error: message });
      }
    }

    // Every eligible post's embedding failed — real input existed and
    // nothing could be processed. This is a failed run, not a completed one
    // with zero clusters; the two must be distinguishable to an editor.
    if (embedded.length === 0) {
      const message = `All ${eligible.length} eligible post(s) failed to embed; see warnings for per-post errors.`;
      await failClusteringRun(db, runId, message);
      return jsonResponse({
        ok: false,
        run_id: runId,
        period_start, period_end,
        error: message,
        totals: { eligible: eligible.length, embedded: 0, embedding_failed: embeddingWarnings.length, clusters: 0, unclustered: 0 },
        clusters: [],
        warnings: embeddingWarnings,
      }, 200, origin);
    }

    // Group by similarity (grouping.ts sorts internally for determinism).
    const { clusters: rawClusters, unclustered } = groupBySimilarity(
      embedded, Number(config.cluster_similarity_threshold), config.min_cluster_size,
    );

    // One LLM label call per cluster. A failed call marks label_failed=true
    // — the cluster and its assignments are still real and are persisted;
    // only the label itself is a visible placeholder, never a fabricated
    // title presented as if generation succeeded.
    const textByPost = new Map(eligible.map((p) => [p.raw_post_id, p.anonymized_text]));
    const clusterInputs: ClusterInput[] = [];
    for (const cluster of rawClusters) {
      const representativeTexts = cluster.postIds.map((id) => textByPost.get(id) ?? "").filter(Boolean);
      let label = "(label generation failed)";
      let labelFailed = true;
      try {
        const result = await callLlm({
          apiKey,
          model: labelModel,
          input: buildClusterLabelPrompt(representativeTexts),
          jsonSchema: buildClusterLabelSchema(),
          fetchImpl: deps.fetchImpl,
        } satisfies CallOpenAiOptions);
        const parsedLabel = result.parsed.label;
        if (typeof parsedLabel === "string" && parsedLabel.trim()) {
          label = parsedLabel.trim();
          labelFailed = false;
        }
      } catch (e) {
        const oe = e instanceof OpenAiError ? e : null;
        console.error(`cluster: label generation failed for a cluster of ${cluster.postIds.length} posts:`, oe?.message ?? e);
      }
      clusterInputs.push({ label, label_failed: labelFailed, post_ids: cluster.postIds });
    }

    // Phase 2 (success path): persist clusters + assignments, mark completed.
    await completeClusteringRun(db, runId, clusterInputs);

    return jsonResponse({
      ok: true,
      run_id: runId,
      period_start, period_end,
      totals: {
        eligible: eligible.length,
        embedded: embedded.length,
        embedding_failed: embeddingWarnings.length,
        clusters: clusterInputs.length,
        unclustered: unclustered.length,
      },
      clusters: clusterInputs.map((c) => ({ label: c.label, label_failed: c.label_failed, post_count: c.post_ids.length })),
      warnings: embeddingWarnings,
    }, 200, origin);
  } catch (e) {
    if (e instanceof RequestError) {
      return jsonResponse({ ok: false, error: e.message }, e.status, origin);
    }
    console.error("cluster failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleCluster(req));
}

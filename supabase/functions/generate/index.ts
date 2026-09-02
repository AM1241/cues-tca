/**
 * POST /functions/v1/generate
 *
 *   {
 *     "clustering_run_id": "<uuid>",
 *     "cluster_ids": ["<uuid>", ...],
 *     "output_types": ["post", "carousel"],       // optional, defaults to both
 *     "regenerates_result_id": "<uuid>",          // optional — makes this a revision
 *     "feedback": "lead with the policy angle"    // optional, requires the above
 *   }
 *
 * Regeneration (0023): naming a previous result puts that draft and the
 * editor's instruction into the prompt, restricts the request to that result's
 * own cluster and outputs, and points the answered review rows at the new
 * result. Nothing is overwritten — cluster_generation_results is append-only,
 * so a revision is a new request producing new rows.
 *
 * On-demand, synchronous generation of editorial drafts (a LinkedIn post and
 * a 5-slide carousel) from one or more clusters within ONE completed
 * clustering_run_id — see docs/PHASE5_KICKOFF.md and CLAUDE.md's pipeline
 * order. `generate` reads only anonymised text (via clustering_run_posts ->
 * anonymize_results), never raw_posts.post_text.
 *
 * Flow, per request:
 *   1. Validate the run exists and is completed; validate every requested
 *      cluster_id belongs to that run (DB-enforced in
 *      create_cluster_generation_request, not just here).
 *   2. create_cluster_generation_request() — a real 'pending' row exists
 *      before any LLM call happens.
 *   3. Per cluster: reject upfront (label_failed, no valid input posts) or
 *      build the prompt, make one structured OpenAI call returning both
 *      post + carousel, and persist via complete_cluster_generation_result.
 *      A cluster's failure never aborts its siblings in the same request.
 *   4. finish_cluster_generation_request() marks the request completed only
 *      if every requested cluster produced a result; failed otherwise. No
 *      partial-success status — the caller must distinguish "everything
 *      worked" from "something didn't".
 *
 * Dual auth (internal secret OR an editor), same as cluster — generation is
 * triggered from the frontend's cluster-selection UI.
 *
 * Fail-loud: no canned/fallback post or carousel is ever emitted. Every
 * failure mode (run missing/not completed, cluster/run mismatch, label_failed
 * cluster, no valid input, LLM/schema failure, persistence failure) is
 * recorded explicitly — either as a 4xx before any request row is created, or
 * as a per-cluster generation_request_errors row with the request ending in
 * status='failed'.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { RequestError } from "../_shared/errors.ts";
import { callOpenAi, OpenAiError, type CallOpenAiOptions } from "../_shared/openai.ts";
import {
  buildGenerationPrompt,
  buildGenerationSchema,
  PROMPT_VERSION,
  type RevisionContext,
  validateGenerationOutput,
} from "./prompt.ts";
import {
  completeGenerationResult,
  createGenerationRequest,
  finishGenerationRequest,
  getClusteringRun,
  getClusterPostInputs,
  getClusters,
  getConfig,
  getGenerationResult,
  recordGenerationError,
  supersedeReview,
} from "./data.ts";

const DEFAULT_MODEL = "gpt-5.4-nano-2026-03-17";
const DEFAULT_OUTPUT_TYPES = ["post", "carousel"];

export interface GenerateDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  callOpenAiImpl?: typeof callOpenAi;
}

interface GenerateRequestBody {
  clustering_run_id: string;
  cluster_ids: string[];
  /** Null when the caller did not say, so a regeneration can inherit the previous result's. */
  output_types: string[] | null;
  feedback: string | null;
  regenerates_result_id: string | null;
}

/** Same bound as the CHECK on cluster_generation_requests.feedback (0023). */
const MAX_FEEDBACK_CHARS = 2000;

function parseBody(body: Record<string, unknown>): GenerateRequestBody {
  const runId = body.clustering_run_id;
  if (typeof runId !== "string" || !runId) {
    throw new RequestError(400, "clustering_run_id is required.");
  }
  const clusterIds = body.cluster_ids;
  if (!Array.isArray(clusterIds) || clusterIds.length === 0 || !clusterIds.every((c) => typeof c === "string" && c)) {
    throw new RequestError(400, "cluster_ids must be a non-empty array of strings.");
  }
  let outputTypes: string[] | null = null;
  if (body.output_types !== undefined) {
    if (
      !Array.isArray(body.output_types) || body.output_types.length === 0 ||
      !body.output_types.every((t) => t === "post" || t === "carousel")
    ) {
      throw new RequestError(400, 'output_types must be a non-empty array containing only "post" and/or "carousel".');
    }
    outputTypes = [...new Set(body.output_types as string[])];
  }

  // A regeneration names the draft it is answering. The database re-checks
  // that the result exists, belongs to the single requested cluster, and
  // actually carries the requested outputs — this is only the shape check.
  let regeneratesResultId: string | null = null;
  if (body.regenerates_result_id !== undefined && body.regenerates_result_id !== null) {
    if (typeof body.regenerates_result_id !== "string" || !body.regenerates_result_id) {
      throw new RequestError(400, "regenerates_result_id must be a non-empty string.");
    }
    regeneratesResultId = body.regenerates_result_id;
  }

  let feedback: string | null = null;
  if (body.feedback !== undefined && body.feedback !== null) {
    if (typeof body.feedback !== "string") {
      throw new RequestError(400, "feedback must be a string.");
    }
    const trimmed = body.feedback.trim();
    if (trimmed.length > MAX_FEEDBACK_CHARS) {
      throw new RequestError(400, `feedback must be at most ${MAX_FEEDBACK_CHARS} characters.`);
    }
    feedback = trimmed || null;
  }
  // Feedback with nothing to apply it to would silently do nothing: a
  // first-pass generation has no previous draft for "make it sharper" to mean
  // anything against.
  if (feedback && !regeneratesResultId) {
    throw new RequestError(400, "feedback requires regenerates_result_id — it revises a specific draft.");
  }

  return {
    clustering_run_id: runId,
    cluster_ids: [...new Set(clusterIds as string[])],
    output_types: outputTypes,
    feedback,
    regenerates_result_id: regeneratesResultId,
  };
}

/**
 * SHA-256, not md5: Web Crypto's subtle.digest does not implement MD5 (unlike
 * this project's SQL-side md5() calls, e.g. anonymize_results.config_hash) —
 * this is just an opaque prompt-identity hash, not required to match that
 * algorithm.
 */
async function promptHashHex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleGenerate(req: Request, deps: GenerateDeps = {}): Promise<Response> {
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

    // Dual auth like cluster: an admin editor from the frontend, or the
    // internal secret for programmatic triggering.
    await authenticate(req, body as Record<string, unknown>);

    const { clustering_run_id, cluster_ids, output_types, feedback, regenerates_result_id } =
      parseBody(body as Record<string, unknown>);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");
    const model = Deno.env.get("GENERATION_MODEL") ?? DEFAULT_MODEL;
    const callLlm = deps.callOpenAiImpl ?? callOpenAi;

    const db = deps.db ?? serviceClient();

    // ---- Upfront validation: run must exist and be completed ----------------
    const run = await getClusteringRun(db, clustering_run_id);
    if (!run) throw new RequestError(404, `clustering_run ${clustering_run_id} not found.`);
    if (run.status !== "completed") {
      throw new RequestError(422, `clustering_run ${clustering_run_id} is not completed (status=${run.status}).`);
    }

    // ---- Upfront validation: every cluster must belong to this run ----------
    const clusters = await getClusters(db, cluster_ids);
    for (const clusterId of cluster_ids) {
      const cluster = clusters.get(clusterId);
      if (!cluster) throw new RequestError(404, `cluster ${clusterId} not found.`);
      if (cluster.clustering_run_id !== clustering_run_id) {
        throw new RequestError(422, `cluster ${clusterId} does not belong to clustering_run ${clustering_run_id}.`);
      }
    }

    // ---- Regeneration: the draft being answered ----------------------------
    // Resolved before the request row is created so a bad id fails as a 4xx
    // with nothing written, matching every other precondition here.
    let previous = null;
    if (regenerates_result_id) {
      previous = await getGenerationResult(db, regenerates_result_id);
      if (!previous) throw new RequestError(404, `cluster_generation_result ${regenerates_result_id} not found.`);
      if (cluster_ids.length !== 1) {
        throw new RequestError(422, "A regeneration covers exactly one cluster.");
      }
      if (previous.cluster_id !== cluster_ids[0]) {
        throw new RequestError(
          422,
          `result ${regenerates_result_id} belongs to cluster ${previous.cluster_id}, not ${cluster_ids[0]}.`,
        );
      }
    }

    // A regeneration defaults to the outputs the previous draft carried, not to
    // both: an editor revising a post must not silently mint a carousel the
    // original never had, and an output the original lacks has nothing to
    // revise. A first-pass generation still defaults to both.
    const prev = previous;
    const effectiveOutputTypes = output_types ?? prev?.output_types ?? DEFAULT_OUTPUT_TYPES;
    if (prev) {
      const missing = effectiveOutputTypes.filter((t) => !prev.output_types.includes(t));
      if (missing.length > 0) {
        throw new RequestError(
          422,
          `result ${regenerates_result_id} has no ${missing.join("/")} output to regenerate.`,
        );
      }
    }

    const config = await getConfig(db);
    const configSnapshot = {
      themes: config.themes,
      voice_tone: config.voice_tone,
      voice_audience: config.voice_audience,
      voice_style: config.voice_style,
    };

    // Phase 1: a real 'pending' row exists before any LLM call happens.
    const requestId = await createGenerationRequest(db, {
      clusteringRunId: clustering_run_id,
      requestedClusterIds: cluster_ids,
      outputTypes: effectiveOutputTypes,
      feedback,
      regeneratesResultId: regenerates_result_id,
    });

    const results: {
      generation_result_id: string;
      cluster_id: string;
      cluster_label: string;
      post?: unknown;
      carousel?: unknown;
    }[] = [];
    const errors: { cluster_id: string; error_type: string; error_message: string }[] = [];

    for (const clusterId of cluster_ids) {
      const cluster = clusters.get(clusterId)!;

      // Only clusters with label_failed=false are eligible.
      if (cluster.label_failed) {
        const message = `cluster ${clusterId} has label_failed=true and is not eligible for generation.`;
        await recordGenerationError(db, { requestId, clusterId, errorType: "label_failed", errorMessage: message });
        errors.push({ cluster_id: clusterId, error_type: "label_failed", error_message: message });
        continue;
      }

      // The exact input posts, resolved through this run's own pinned
      // anonymize_result_id — never anonymized_posts_current.
      const inputs = await getClusterPostInputs(db, clustering_run_id, clusterId);
      if (inputs.length === 0) {
        const message = `cluster ${clusterId} has no valid assignments with a resolvable anonymisation result.`;
        await recordGenerationError(db, { requestId, clusterId, errorType: "no_valid_input", errorMessage: message });
        errors.push({ cluster_id: clusterId, error_type: "no_valid_input", error_message: message });
        continue;
      }

      // The revision context names ONE previous draft. When both outputs are
      // being regenerated the post is shown, because that is the copy an
      // editor reads first and writes feedback about; the carousel is derived
      // from the same evidence in the same call.
      const revision: RevisionContext | undefined = prev
        ? {
          feedback,
          previousOutputType: effectiveOutputTypes.includes("post") ? "post" : "carousel",
          previousOutput: effectiveOutputTypes.includes("post") ? prev.post_output : prev.carousel_output,
        }
        : undefined;
      const prompt = buildGenerationPrompt(cluster.label, inputs, config, revision);
      const promptHash = await promptHashHex(prompt);

      let parsed;
      let rawResponse: unknown;
      try {
        const result = await callLlm({
          apiKey,
          model,
          input: prompt,
          jsonSchema: buildGenerationSchema(),
          fetchImpl: deps.fetchImpl,
        } satisfies CallOpenAiOptions);
        parsed = validateGenerationOutput(result.parsed);
        rawResponse = result.raw;
      } catch (e) {
        const oe = e instanceof OpenAiError ? e : null;
        const errorType = oe ? `llm_${oe.failureType}` : "schema_error";
        const message = (e as Error).message;
        console.error(`generate: LLM/schema failure for cluster ${clusterId}:`, message);
        await recordGenerationError(db, { requestId, clusterId, errorType, errorMessage: message });
        errors.push({ cluster_id: clusterId, error_type: errorType, error_message: message });
        continue;
      }

      const postOutput = effectiveOutputTypes.includes("post") ? parsed.post : null;
      const carouselOutput = effectiveOutputTypes.includes("carousel") ? parsed.carousel : null;

      try {
        const resultId = await completeGenerationResult(db, {
          requestId,
          clusterId,
          clusterLabel: cluster.label,
          rawPostIds: inputs.map((i) => i.raw_post_id),
          anonymizeResultIds: inputs.map((i) => i.anonymize_result_id),
          outputTypes: effectiveOutputTypes,
          postOutput: postOutput as Record<string, unknown> | null,
          carouselOutput: carouselOutput as Record<string, unknown> | null,
          configSnapshot,
          promptVersion: PROMPT_VERSION,
          promptHash,
          model,
          providerResponse: rawResponse,
        });
        // Point the answered draft at its replacement. Deliberately after the
        // result is persisted and deliberately non-fatal: the generation has
        // already succeeded, and turning a good result into a 500 because a
        // bookkeeping update failed would lose copy the editor just paid for.
        // The cost of failing here is an old row that still reads 'draft'.
        if (prev) {
          for (const outputType of effectiveOutputTypes) {
            try {
              await supersedeReview(db, {
                oldResultId: prev.id,
                outputType,
                newResultId: resultId,
              });
            } catch (e) {
              console.error(
                `generate: could not supersede review ${prev.id}/${outputType}:`,
                (e as Error).message,
              );
            }
          }
        }

        results.push({
          generation_result_id: resultId,
          cluster_id: clusterId,
          cluster_label: cluster.label,
          ...(postOutput ? { post: postOutput } : {}),
          ...(carouselOutput ? { carousel: carouselOutput } : {}),
        });
      } catch (e) {
        const message = (e as Error).message;
        console.error(`generate: persistence failure for cluster ${clusterId} after a successful LLM call:`, message);
        await recordGenerationError(db, { requestId, clusterId, errorType: "persistence_error", errorMessage: message });
        errors.push({ cluster_id: clusterId, error_type: "persistence_error", error_message: message });
      }
    }

    const finalStatus = await finishGenerationRequest(db, requestId);

    if (finalStatus !== "completed") {
      return jsonResponse({
        ok: false,
        generation_request_id: requestId,
        error: `${errors.length} of ${cluster_ids.length} requested cluster(s) failed to generate.`,
        results,
        errors,
      }, 200, origin);
    }

    return jsonResponse({
      ok: true,
      generation_request_id: requestId,
      results,
    }, 200, origin);
  } catch (e) {
    if (e instanceof RequestError) {
      return jsonResponse({ ok: false, error: e.message }, e.status, origin);
    }
    console.error("generate failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleGenerate(req));
}

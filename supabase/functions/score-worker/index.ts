/**
 * POST /functions/v1/score-worker
 *
 * Drains a bounded batch of the `scoring_jobs` queue: reads up to
 * `batch_size` jobs, scores each with the OpenAI Responses API using the
 * prompt/model/config pinned on that job's scoring_request (never chosen by
 * this function), and reports success/failure per job through the RPCs that
 * own the state machine (`complete_scoring_job` / `record_scoring_failure` /
 * dead-letter is reached automatically after 3 failures).
 *
 *   { "batch_size": 1..25? }   // default 10
 *
 * Internal-secret auth only (cron / backfill) — there is no browser path for
 * this function; scoring is driven entirely by the queue, not by a user
 * clicking a button per post.
 *
 * One job's failure never aborts the batch: each job is wrapped so a thrown
 * error is recorded via record_scoring_failure and the loop continues.
 *
 * The handler is exported with injectable dependencies so the whole flow can
 * be exercised against the local stack with a scripted OpenAI — no test in
 * this repo is permitted to reach the real API.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { RequestError } from "../_shared/errors.ts";
import { callOpenAi, OpenAiError, type CallOpenAiOptions } from "../_shared/openai.ts";
import { buildScoringPrompt, buildScoringSchema } from "./prompt.ts";
import {
  completeJob,
  getRawPost,
  getScoringRequest,
  readJobs,
  recordFailure,
  type QueueMessage,
  type ScoringRequestRow,
} from "./queue.ts";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;

export interface ScoreWorkerDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  callOpenAiImpl?: typeof callOpenAi;
}

function parseBatchSize(body: Record<string, unknown>): number {
  const raw = body.batch_size;
  if (raw === undefined || raw === null) return DEFAULT_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
    throw new RequestError(400, `batch_size must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return n;
}

interface JobOutcome {
  job_id: string;
  raw_post_id: string;
  status: "scored" | "duplicate" | "retry" | "dead_letter" | "superseded" | "infra_error";
  error_code?: string;
}

async function processJob(
  db: SupabaseClient,
  msg: QueueMessage,
  requestCache: Map<string, ScoringRequestRow>,
  apiKey: string,
  deps: ScoreWorkerDeps,
): Promise<JobOutcome> {
  const { job_id: jobId, raw_post_id: rawPostId, scoring_request_id: requestId } = msg.message;
  const token = msg.processing_token;
  const call = deps.callOpenAiImpl ?? callOpenAi;

  let request = requestCache.get(requestId);
  if (!request) {
    request = await getScoringRequest(db, requestId);
    requestCache.set(requestId, request);
  }

  const themes = request.config_snapshot.themes;
  const post = await getRawPost(db, rawPostId);

  // Stage 1 — the OpenAI call. A failure here is a *business* failure and is
  // routed through record_scoring_failure (retry / dead-letter accounting).
  let result;
  try {
    result = await call({
      apiKey,
      model: request.model_snapshot,
      input: buildScoringPrompt(
        request.prompt_template,
        { sourceName: post.source_name, postId: post.id, text: post.post_text },
        themes,
      ),
      jsonSchema: buildScoringSchema(themes),
      fetchImpl: deps.fetchImpl,
    } satisfies CallOpenAiOptions);
  } catch (e) {
    const oe = e instanceof OpenAiError ? e : null;
    const failureType = oe?.failureType ?? "unknown";
    const outcome = await recordFailure(db, {
      jobId, msgId: msg.msg_id, rawPostId, requestId, processingToken: token,
      failureType, errorCode: oe?.httpStatus?.toString(), errorMessage: (e as Error).message,
      providerResponse: oe?.rawResponse,
    });
    return { job_id: jobId, raw_post_id: rawPostId, status: outcome, error_code: failureType };
  }

  // Stage 2 — persist the result. A failure HERE is *infrastructure*, not a
  // scoring failure: the OpenAI work succeeded, so it must NOT burn a business
  // retry. The job stays leased and the message un-archived; its visibility
  // timeout expires, a later drain re-claims it, and completion is idempotent
  // (same idempotency_key), so re-scoring is safe. Persistent infra faults keep
  // retrying rather than dead-lettering good work — deliberate.
  try {
    const themeScores = result.parsed.theme_scores as Record<string, number>;
    const reason = result.parsed.reason as string;
    const outcome = await completeJob(db, {
      jobId, msgId: msg.msg_id, rawPostId, requestId, processingToken: token,
      themeScores, reason, providerResponse: result.raw,
    });
    const status = outcome === "inserted" ? "scored" : outcome; // "duplicate" | "superseded"
    return { job_id: jobId, raw_post_id: rawPostId, status };
  } catch (e) {
    console.error(`score-worker: DB completion failed for job ${jobId} after a successful OpenAI call:`, e);
    return { job_id: jobId, raw_post_id: rawPostId, status: "infra_error" };
  }
}

export async function handleScoreWorker(req: Request, deps: ScoreWorkerDeps = {}): Promise<Response> {
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

    // Auth first, same as ingest: nothing is read from the queue until the
    // caller is verified. This function has no editor path — only the
    // internal secret (cron / backfill) may drain the queue.
    const actor = await authenticate(req, body as Record<string, unknown>);
    if (actor.kind !== "internal") {
      throw new RequestError(403, "score-worker is driven by the queue, not by a user request.");
    }

    const batchSize = parseBatchSize(body as Record<string, unknown>);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");

    const db = deps.db ?? serviceClient();
    const messages = await readJobs(db, batchSize);

    const requestCache = new Map<string, ScoringRequestRow>();
    const results: JobOutcome[] = [];
    for (const msg of messages) {
      results.push(await processJob(db, msg, requestCache, apiKey, deps));
    }

    const totals = {
      jobs_read: messages.length,
      scored: results.filter((r) => r.status === "scored").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      retried: results.filter((r) => r.status === "retry").length,
      dead_lettered: results.filter((r) => r.status === "dead_letter").length,
      superseded: results.filter((r) => r.status === "superseded").length,
      infra_error: results.filter((r) => r.status === "infra_error").length,
    };

    return jsonResponse({ ok: true, totals, results }, 200, origin);
  } catch (e) {
    if (e instanceof RequestError) {
      return jsonResponse({ ok: false, error: e.message }, e.status, origin);
    }
    console.error("score-worker failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleScoreWorker(req));
}

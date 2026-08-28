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
 *   { "batch_size": 1..25? }   // default 10; browser callers are capped lower,
 *                              // see MANUAL_BATCH_CAP
 *
 * Dual auth (cron / backfill secret, or an admin editor's token) — scoring is
 * still driven entirely by the queue, never per post; the browser path only
 * drains whatever the queue already holds.
 *
 * Completion promotes: each scored post is written to scoring_results AND
 * projected onto analyzed_posts in one transaction, via
 * complete_and_promote_scoring_job. Scoring that only appends history is
 * invisible to the product — see 0018_scoring_promote_on_complete.sql.
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
import { authenticate, type Actor } from "../_shared/auth.ts";
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

/**
 * How much provider spend one browser click may commit.
 *
 * Cloud v7 answered this with a blanket `actor.kind !== "internal"` reject,
 * which left "Score now" permanently 403 in production and contradicted this
 * file's own documented dual-auth contract. It also could not work: the internal
 * path authenticates with INGEST_INTERNAL_SECRET, which _shared/auth.ts requires
 * to be "never present in a browser" — so no UI could ever satisfy it.
 *
 * The concern behind it is still real, so it is kept as a bound rather than a
 * wall. Note what is already guaranteed without any check here: this function
 * takes no post identifier, only a count, so it cannot score on demand — it can
 * only work through what ingest already queued, and once the queue is empty a
 * click does nothing. Editor callers are admin-only (enforced in auth.ts) and
 * recorded with trigger_source 'manual', so manual spend stays attributable.
 * What remains is how much one click costs, and that is this cap.
 *
 * To re-tighten to internal-only, set this to 0 — one line, no logic change.
 * Annotated `number` rather than left to inference so that 0 stays a reachable
 * value: with the literal type, the zero check below is a type error.
 */
const MANUAL_BATCH_CAP: number = DEFAULT_BATCH_SIZE;

export interface ScoreWorkerDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  callOpenAiImpl?: typeof callOpenAi;
}

function parseBatchSize(body: Record<string, unknown>, actorKind: Actor["kind"]): number {
  const cap = actorKind === "internal" ? MAX_BATCH_SIZE : MANUAL_BATCH_CAP;
  if (cap === 0) {
    throw new RequestError(403, "score-worker is driven by the queue, not by a user request.");
  }
  const raw = body.batch_size;
  if (raw === undefined || raw === null) return Math.min(DEFAULT_BATCH_SIZE, cap);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > cap) {
    throw new RequestError(400, `batch_size must be an integer between 1 and ${cap}.`);
  }
  return n;
}

interface JobOutcome {
  job_id: string;
  raw_post_id: string;
  status: "scored" | "duplicate" | "retry" | "dead_letter" | "superseded" | "infra_error" | "circuit_break";
  error_code?: string;
}

async function processJob(
  db: SupabaseClient,
  msg: QueueMessage,
  requestCache: Map<string, ScoringRequestRow>,
  apiKey: string,
  deps: ScoreWorkerDeps,
  closedRequestIds: Set<string>,
): Promise<JobOutcome> {
  const { job_id: jobId, raw_post_id: rawPostId, scoring_request_id: requestId } = msg.message;
  const token = msg.processing_token;
  const call = deps.callOpenAiImpl ?? callOpenAi;

  // A sibling job earlier in THIS SAME batch may have already circuit-broken
  // this request (in-memory, checked before any DB round-trip or OpenAI
  // call). This is required, not just an optimization: relying solely on the
  // DB state and letting complete_scoring_job/record_scoring_failure return
  // 'superseded' after the fact would still spend a real OpenAI call on a
  // request already known to be broken — the whole point of the circuit
  // break is to prevent that call from happening at all. Cross-worker
  // closures (a different invocation closed the request between reads) are
  // caught by the fresh scoring_requests.status re-check below, since
  // requestCache is only populated once per batch and could be stale.
  if (closedRequestIds.has(requestId)) {
    return { job_id: jobId, raw_post_id: rawPostId, status: "circuit_break", error_code: "request_closed" };
  }

  let request = requestCache.get(requestId);
  if (!request) {
    request = await getScoringRequest(db, requestId);
    requestCache.set(requestId, request);
  }

  // Cross-worker guard: this request's status was cached (possibly stale) or
  // fetched just now — either way, re-check it fresh immediately before the
  // paid call, since a concurrent worker on a different job under the same
  // request could have closed it since requestCache was populated.
  if (request.status !== "active") {
    closedRequestIds.add(requestId);
    return { job_id: jobId, raw_post_id: rawPostId, status: "circuit_break", error_code: "request_closed" };
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
        // Pre-0019 requests pinned no domain and their stored template has no
        // {{DOMAIN}} placeholder, so the value is never rendered for them. The
        // empty string keeps that path literal rather than inventing a scope.
        request.config_snapshot.editorial_domain ?? "",
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
    if (outcome === "circuit_break") closedRequestIds.add(requestId);
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

    // Auth first, same as ingest and cluster: nothing is read from the queue
    // until the caller is verified. Two ways in — the internal secret
    // (cron / backfill), or an admin editor's Bearer token, because the product
    // drives every stage from a button in the UI. _shared/auth.ts is the gate
    // either way, and it is what enforces the admin-only rule on the editor path.
    const actor = await authenticate(req, body as Record<string, unknown>);

    // The batch ceiling depends on who is calling: see MANUAL_BATCH_CAP.
    const batchSize = parseBatchSize(body as Record<string, unknown>, actor.kind);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");

    const db = deps.db ?? serviceClient();
    const messages = await readJobs(db, batchSize);

    const requestCache = new Map<string, ScoringRequestRow>();
    // Requests this batch has itself circuit-broken. Checked before every
    // OpenAI call in processJob so a later job in the SAME batch, under the
    // SAME request, never reaches OpenAI once an earlier job in this batch
    // has already learned the request is closed — the DB round-trip that
    // would also catch this (complete/record returning 'superseded' or the
    // fresh status re-check) happens too late to prevent that call.
    const closedRequestIds = new Set<string>();
    const results: JobOutcome[] = [];
    for (const msg of messages) {
      results.push(await processJob(db, msg, requestCache, apiKey, deps, closedRequestIds));
    }

    const totals = {
      jobs_read: messages.length,
      scored: results.filter((r) => r.status === "scored").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
      retried: results.filter((r) => r.status === "retry").length,
      dead_lettered: results.filter((r) => r.status === "dead_letter").length,
      superseded: results.filter((r) => r.status === "superseded").length,
      infra_error: results.filter((r) => r.status === "infra_error").length,
      circuit_break: results.filter((r) => r.status === "circuit_break").length,
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

/**
 * POST /functions/v1/anonymize-worker
 *
 * Drains a bounded batch of the `anonymize_jobs` queue: for each job, applies
 * the deterministic replacement (source name / public-body preservation /
 * number bucketing — deterministic.ts) then an LLM entity-extraction pass
 * (entity.ts) to catch companies named in body text that don't match the
 * source, merges both into one replacements audit trail, and persists via
 * `complete_anonymize_job`.
 *
 *   { "batch_size": 1..25? }   // default 10
 *
 * Internal-secret auth only, same as score-worker — anonymisation is driven
 * by an operator calling backfill_anonymize_jobs() then draining this
 * function, not by a per-post UI action.
 *
 * Fail-loud (PHASE4_REQUIREMENTS.md §1): if the LLM entity-extraction call
 * fails, the post is NOT completed under a success state — the failure is
 * routed to record_anonymize_failure and anonymized_posts_current is left
 * untouched. There is no silent fallback to deterministic-only output under
 * a "success" status. One job's failure never aborts the batch.
 *
 * Unlike score-worker, there is no shared "request" and therefore no
 * circuit-break: each post's entity-extraction call is independent, so one
 * client error does not imply its siblings will fail identically.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { RequestError } from "../_shared/errors.ts";
import { callOpenAi, OpenAiError, type CallOpenAiOptions } from "../_shared/openai.ts";
import { applyDeterministicReplacement, type Replacement } from "./deterministic.ts";
import { buildEntityExtractionPrompt, buildEntityExtractionSchema, parseEntityExtractionResult } from "./entity.ts";
import {
  completeJob,
  getConfig,
  getRawPost,
  readJobs,
  recordFailure,
  type ConfigRow,
  type QueueMessage,
} from "./queue.ts";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 25;

export interface AnonymizeWorkerDeps {
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
  status: "anonymized" | "duplicate" | "retry" | "dead_letter" | "superseded" | "infra_error";
  error_code?: string;
}

async function processJob(
  db: SupabaseClient,
  msg: QueueMessage,
  config: ConfigRow,
  apiKey: string,
  deps: AnonymizeWorkerDeps,
): Promise<JobOutcome> {
  const { job_id: jobId, raw_post_id: rawPostId } = msg.message;
  const token = msg.processing_token;
  const call = deps.callOpenAiImpl ?? callOpenAi;

  const post = await getRawPost(db, rawPostId);

  // Stage 1 — deterministic replacement (source name / public bodies / number
  // bucketing). Pure, cannot fail against well-formed input.
  const deterministic = applyDeterministicReplacement(post.post_text, post.source_name, {
    anonymizeCompanies: config.anonymize_companies,
    keepPublicBodies: config.keep_public_bodies,
    companyAliases: config.company_aliases ?? {},
  });

  // Stage 2 — LLM entity extraction, catching companies named in body text
  // that Stage 1 doesn't know about. A failure here is a *business* failure,
  // routed through record_anonymize_failure — per the fail-loud requirement,
  // this post's anonymisation does NOT complete under a success state, and
  // no deterministic-only text is ever written as if it were the full result.
  let entities: string[];
  let rawResponse: unknown;
  try {
    const result = await call({
      apiKey,
      model: Deno.env.get("ANONYMIZE_ENTITY_MODEL") ?? "gpt-5.4-nano-2026-03-17",
      input: buildEntityExtractionPrompt(post.source_name, deterministic.text),
      jsonSchema: buildEntityExtractionSchema(),
      fetchImpl: deps.fetchImpl,
    } satisfies CallOpenAiOptions);
    entities = parseEntityExtractionResult(result.parsed).entities;
    rawResponse = result.raw;
  } catch (e) {
    const oe = e instanceof OpenAiError ? e : null;
    const failureType = oe?.failureType ?? "unknown";
    const outcome = await recordFailure(db, {
      jobId, msgId: msg.msg_id, rawPostId, processingToken: token,
      failureType, errorCode: oe?.httpStatus?.toString(), errorMessage: (e as Error).message,
      providerResponse: oe?.rawResponse,
    });
    return { job_id: jobId, raw_post_id: rawPostId, status: outcome, error_code: failureType };
  }

  // Merge Stage 1 + Stage 2 findings into one audit trail, applying the
  // LLM-found entities on top of the already-deterministically-replaced text.
  let finalText = deterministic.text;
  const replacements: Replacement[] = [...deterministic.replacements];
  const generic = "another food-sector organization";
  for (const entity of entities) {
    if (!entity || !finalText.includes(entity)) continue;
    finalText = finalText.split(entity).join(generic);
    replacements.push({ original: entity, replacement: generic, source: "entity_extraction" });
  }

  // Stage 3 — persist. A failure HERE is infrastructure, not business: the
  // LLM work succeeded, so it must not burn a retry. The job stays leased;
  // the visibility timeout naturally re-triggers a retry, and completion is
  // idempotent (idempotency_key), so re-completion is safe.
  try {
    const outcome = await completeJob(db, {
      jobId, msgId: msg.msg_id, rawPostId, processingToken: token,
      anonymizedText: finalText, replacements, generalizedSourceName: deterministic.generalizedSourceName,
      configSnapshot: {
        anonymization_enabled: config.anonymization_enabled,
        anonymize_companies: config.anonymize_companies,
        keep_public_bodies: config.keep_public_bodies,
      },
      providerResponse: rawResponse,
    });
    const status = outcome === "inserted" ? "anonymized" : outcome; // "duplicate" | "superseded"
    return { job_id: jobId, raw_post_id: rawPostId, status };
  } catch (e) {
    console.error(`anonymize-worker: DB completion failed for job ${jobId} after a successful LLM call:`, e);
    return { job_id: jobId, raw_post_id: rawPostId, status: "infra_error" };
  }
}

export async function handleAnonymizeWorker(req: Request, deps: AnonymizeWorkerDeps = {}): Promise<Response> {
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

    // Internal-secret only, same as score-worker: this function is driven by
    // the queue (an operator's backfill call), not a per-post UI action.
    const actor = await authenticate(req, body as Record<string, unknown>);
    if (actor.kind !== "internal") {
      throw new RequestError(403, "anonymize-worker is driven by the queue, not by a user request.");
    }

    const batchSize = parseBatchSize(body as Record<string, unknown>);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");

    const db = deps.db ?? serviceClient();
    const messages = await readJobs(db, batchSize);

    const results: JobOutcome[] = [];
    if (messages.length > 0) {
      const config = await getConfig(db);
      for (const msg of messages) {
        results.push(await processJob(db, msg, config, apiKey, deps));
      }
    }

    const totals = {
      jobs_read: messages.length,
      anonymized: results.filter((r) => r.status === "anonymized").length,
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
    console.error("anonymize-worker failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleAnonymizeWorker(req));
}

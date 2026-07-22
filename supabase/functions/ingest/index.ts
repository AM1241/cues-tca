/**
 * POST /functions/v1/ingest
 *
 * Collect LinkedIn posts for the configured sources.
 *
 *   { "source_ids": ["uuid", ...]?,   // omit for every enabled source
 *     "lookback_days": 1..90?,        // per-source default otherwise
 *     "dry_run": false? }             // still calls the provider; skips writes
 *
 * trigger_source is derived from the credential, never from this body.
 * Sources are processed one at a time under a per-source lock, and a failure on
 * one never aborts the others.
 *
 * The handler is exported with injectable dependencies so the whole flow can be
 * exercised against the local stack with a scripted provider — no test in this
 * repo is permitted to reach RapidAPI.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { ProviderError, RequestError } from "../_shared/errors.ts";
import { parseRequest } from "./request.ts";
import { collectCompanyPosts, DEFAULT_HOST } from "./provider.ts";
import { upsertPost } from "./upsert.ts";
import {
  claimSource,
  createRun,
  failRun,
  finalizeRun,
  finishSource,
  reapStale,
  recordSkippedSource,
} from "./runs.ts";
import { emptyCounters, type SourceRow } from "./types.ts";

/**
 * Whole-invocation budget. The platform kills an Edge Function at roughly 400s;
 * stopping ourselves well before that means partial results are persisted and
 * the run is finalized properly instead of being lost with sources stuck in
 * 'running'.
 */
export const EXECUTION_BUDGET_MS = 240_000;

export interface IngestDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Absolute epoch ms after which no further source is started. */
  deadline?: number;
}

export async function handleIngest(req: Request, deps: IngestDeps = {}): Promise<Response> {
  const origin = req.headers.get("Origin");

  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405, origin);
  }

  const deadline = deps.deadline ?? Date.now() + EXECUTION_BUDGET_MS;
  let runId: string | null = null;
  let db: SupabaseClient | null = null;

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

    // Auth first: an unauthorised caller must never create a run row.
    const actor = await authenticate(req, body as Record<string, unknown>);
    const request = parseRequest(body);

    const apiKey = Deno.env.get("RAPIDAPI_KEY");
    if (!apiKey) throw new RequestError(500, "RAPIDAPI_KEY is not configured.");
    const host = Deno.env.get("RAPIDAPI_HOST") ?? DEFAULT_HOST;

    db = deps.db ?? serviceClient();
    await reapStale(db);

    // ---- resolve sources -------------------------------------------------
    let query = db
      .from("sources")
      .select("id, name, enabled, rapidapi_identifier, lookback_days")
      .order("name");
    if (request.sourceIds) query = query.in("id", request.sourceIds);

    const { data: sourceRows, error: srcErr } = await query;
    if (srcErr) throw new Error(`sources lookup failed: ${srcErr.message}`);
    const sources = (sourceRows ?? []) as SourceRow[];

    // Unknown ids are a client error, not a silent no-op — and this is checked
    // before the run row exists, so a bad request leaves no trace.
    if (request.sourceIds) {
      const found = new Set(sources.map((s) => s.id));
      const missing = request.sourceIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw new RequestError(400, `Unknown source_ids: ${missing.join(", ")}`);
      }
    }
    if (sources.length === 0) {
      throw new RequestError(400, "No sources matched the request.");
    }

    runId = await createRun(db, actor, {
      dryRun: request.dryRun,
      requestedSourceIds: request.sourceIds ?? [],
      lookbackOverride: request.lookbackOverride,
    });

    const results: Record<string, unknown>[] = [];

    for (const source of sources) {
      // ---- reasons not to spend quota, checked before claiming ----------
      if (!source.enabled) {
        await recordSkippedSource(db, runId, source, "disabled", "Source is disabled.");
        results.push({ source_id: source.id, name: source.name, status: "skipped", error_code: "disabled" });
        continue;
      }
      if (!source.rapidapi_identifier) {
        await recordSkippedSource(db, runId, source, "no_rapidapi_identifier", "No provider identifier configured.");
        results.push({ source_id: source.id, name: source.name, status: "skipped", error_code: "no_rapidapi_identifier" });
        continue;
      }
      if (Date.now() >= deadline) {
        // Persist the real reason. Recording this as 'locked' would blame
        // contention for what is actually us running out of time, and the
        // finalizer counts budget_exhausted as a failure so the run cannot
        // report 'completed' while silently dropping requested sources.
        await recordSkippedSource(
          db, runId, source, "budget_exhausted",
          "Execution budget exhausted before this source was attempted.",
        );
        results.push({ source_id: source.id, name: source.name, status: "skipped", error_code: "budget_exhausted" });
        continue;
      }

      // ---- per-source lock ------------------------------------------------
      const claimed = await claimSource(db, runId, source);
      if (!claimed) {
        await recordSkippedSource(db, runId, source, "locked", "Another run is collecting this source.");
        results.push({ source_id: source.id, name: source.name, status: "skipped", error_code: "locked" });
        continue;
      }

      const counters = emptyCounters();
      const lookback = request.lookbackOverride ?? source.lookback_days;

      try {
        const collected = await collectCompanyPosts(source.rapidapi_identifier, lookback, {
          apiKey,
          host,
          deadline,
          fetchImpl: deps.fetchImpl,
          sleep: deps.sleep,
        });

        counters.pages_fetched = collected.pagesFetched;
        counters.provider_requests = collected.providerRequests;
        counters.truncated = collected.truncated;
        counters.posts_fetched = collected.rawCount;
        counters.posts_skipped_no_id = collected.skippedNoId;
        counters.posts_skipped_malformed = collected.skippedMalformed;
        counters.posts_skipped_out_of_window = collected.outOfWindow;

        if (!request.dryRun) {
          const seenAt = new Date().toISOString();
          for (const post of collected.posts) {
            const outcome = await upsertPost(db, source.id, runId, post, seenAt);
            if (outcome === "inserted") counters.posts_inserted++;
            else if (outcome === "content_changed") counters.posts_content_changed++;
            else {
              counters.posts_metadata_refreshed++;
              counters.posts_skipped_duplicate++;
            }
          }
        }

        await finishSource(db, runId, source.id, "ok", counters);
        results.push({ source_id: source.id, name: source.name, status: "ok", ...counters });
      } catch (e) {
        const pe = e instanceof ProviderError ? e : null;
        // Attempts made before the failure still cost quota.
        if (typeof pe?.providerRequests === "number") {
          counters.provider_requests = pe.providerRequests;
        } else if (pe) {
          counters.provider_requests = pe.attempts || 0;
        }

        const status = pe ? pe.sourceStatus : "failed";
        await finishSource(db, runId, source.id, status, counters, {
          errorCode: pe?.code ?? "network",
          message: (e as Error).message?.slice(0, 500),
          httpStatus: pe?.httpStatus,
          retryAfter: pe?.retryAfterSeconds,
        });
        results.push({
          source_id: source.id,
          name: source.name,
          status,
          error_code: pe?.code ?? "network",
          ...counters,
        });

        // A bad key fails identically for every source; stop rather than
        // spending an attempt per source to learn the same thing.
        if (pe?.code === "auth") break;
      }
    }

    const finalStatus = await finalizeRun(db, runId);
    const { data: run } = await db.from("ingest_runs").select("*").eq("id", runId).single();

    return jsonResponse(
      { ok: finalStatus !== "failed", run_id: runId, status: finalStatus, dry_run: request.dryRun, totals: run, results },
      200,
      origin,
    );
  } catch (e) {
    if (runId && db) {
      try {
        await failRun(db, runId, (e as Error).message?.slice(0, 500) ?? "unknown");
        await finalizeRun(db, runId);
      } catch { /* reporting must not mask the original failure */ }
    }
    if (e instanceof RequestError) {
      return jsonResponse({ ok: false, error: e.message }, e.status, origin);
    }
    console.error("ingest failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleIngest(req));
}

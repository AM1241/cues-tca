/** ingest_runs / ingest_run_sources lifecycle. */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Actor } from "../_shared/auth.ts";
import type { SourceCounters } from "./types.ts";

/**
 * Sweep anything a crashed invocation left behind before starting.
 * Cheap, and it is the only thing that unsticks a source whose claim was never
 * released.
 */
export async function reapStale(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc("reap_stale_ingest", { p_stale_after: "15 minutes" });
  if (error) throw new Error(`reap_stale_ingest failed: ${error.message}`);
}

export async function createRun(
  db: SupabaseClient,
  actor: Actor,
  opts: { dryRun: boolean; requestedSourceIds: string[]; lookbackOverride: number | null },
): Promise<string> {
  const { data, error } = await db
    .from("ingest_runs")
    .insert({
      trigger_source: actor.triggerSource,
      triggered_by: actor.kind === "editor" ? actor.userId : null,
      triggered_by_email: actor.kind === "editor" ? actor.email : null,
      dry_run: opts.dryRun,
      requested_source_ids: opts.requestedSourceIds,
      lookback_days_override: opts.lookbackOverride,
    })
    .select("id")
    .single();

  if (error) throw new Error(`ingest_runs insert failed: ${error.message}`);
  return data.id as string;
}

/** Returns false when another run already holds this source. */
export async function claimSource(
  db: SupabaseClient,
  runId: string,
  source: { id: string; name: string; rapidapi_identifier: string | null },
): Promise<boolean> {
  const { data, error } = await db.rpc("claim_source_for_ingest", {
    p_run_id: runId,
    p_source_id: source.id,
    p_source_name: source.name,
    p_identifier: source.rapidapi_identifier,
    p_stale_after: "15 minutes",
  });
  if (error) throw new Error(`claim_source_for_ingest failed: ${error.message}`);
  return data === true;
}

/**
 * Record a source that was never attempted. Written directly rather than via
 * the claim path: skipping costs no quota and must not contend for the lock.
 */
export async function recordSkippedSource(
  db: SupabaseClient,
  runId: string,
  source: { id: string; name: string; rapidapi_identifier: string | null },
  errorCode: "disabled" | "no_rapidapi_identifier" | "locked",
  message: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from("ingest_run_sources").insert({
    run_id: runId,
    source_id: source.id,
    source_name: source.name,
    rapidapi_identifier: source.rapidapi_identifier,
    status: "skipped",
    error_code: errorCode,
    error_message: message,
    started_at: now,
    finished_at: now,
  });
  if (error) throw new Error(`ingest_run_sources skip insert failed: ${error.message}`);
}

export async function finishSource(
  db: SupabaseClient,
  runId: string,
  sourceId: string,
  status: "ok" | "failed" | "rate_limited" | "auth_failed",
  counters: SourceCounters,
  failure?: { errorCode?: string; message?: string; httpStatus?: number; retryAfter?: number },
): Promise<void> {
  const { error } = await db
    .from("ingest_run_sources")
    .update({
      status,
      finished_at: new Date().toISOString(),
      ...counters,
      error_code: failure?.errorCode ?? null,
      error_message: failure?.message ?? null,
      http_status: failure?.httpStatus ?? null,
      retry_after_seconds: failure?.retryAfter ?? null,
    })
    .eq("run_id", runId)
    .eq("source_id", sourceId);
  if (error) throw new Error(`ingest_run_sources update failed: ${error.message}`);
}

/** Totals are recomputed from the source rows; see finalize_ingest_run. */
export async function finalizeRun(db: SupabaseClient, runId: string): Promise<string | null> {
  const { data, error } = await db.rpc("finalize_ingest_run", { p_run_id: runId });
  if (error) throw new Error(`finalize_ingest_run failed: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Last resort when the orchestrator itself fails. */
export async function failRun(db: SupabaseClient, runId: string, message: string): Promise<void> {
  await db
    .from("ingest_runs")
    .update({ status: "failed", finished_at: new Date().toISOString(), error: message })
    .eq("id", runId)
    .eq("status", "running");
}

/** scoring_jobs queue + scoring_requests lifecycle wrappers. */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";

export interface QueueMessage {
  msg_id: number;
  message: { job_id: string; raw_post_id: string; scoring_request_id: string };
  /** The lease token stamped on the job when this batch claimed it (0009).
   * Passed back to complete/record so a superseded worker is rejected. */
  processing_token: string | null;
}

/** Visibility timeout for a claimed message, in seconds. Generous — a slow
 * OpenAI call plus our own retry bookkeeping must fit comfortably inside it,
 * or the message becomes visible again while still being worked. */
export const VISIBILITY_TIMEOUT_SECONDS = 120;

export async function readJobs(
  db: SupabaseClient,
  qty: number,
  vt: number = VISIBILITY_TIMEOUT_SECONDS,
): Promise<QueueMessage[]> {
  const { data, error } = await db.rpc("read_scoring_jobs", { p_vt: vt, p_qty: qty });
  if (error) throw new Error(`read_scoring_jobs failed: ${error.message}`);
  return (data ?? []) as QueueMessage[];
}

export interface ScoringRequestRow {
  id: string;
  status: string;
  model: string;
  model_snapshot: string;
  prompt_version: string;
  prompt_template: string;
  config_snapshot: { themes: { theme_id: string; label: string; position: number }[]; min_relevance_score: number };
  aggregation_strategy: string;
}

export async function getScoringRequest(db: SupabaseClient, requestId: string): Promise<ScoringRequestRow> {
  const { data, error } = await db
    .from("scoring_requests")
    .select("id, status, model, model_snapshot, prompt_version, prompt_template, config_snapshot, aggregation_strategy")
    .eq("id", requestId)
    .single();
  if (error) throw new Error(`scoring_requests lookup failed: ${error.message}`);
  return data as unknown as ScoringRequestRow;
}

export interface RawPostRow {
  id: string;
  post_text: string;
  source_id: string;
}

export async function getRawPost(db: SupabaseClient, rawPostId: string): Promise<RawPostRow & { source_name: string }> {
  const { data, error } = await db
    .from("raw_posts")
    .select("id, post_text, source_id, sources(name)")
    .eq("id", rawPostId)
    .single();
  if (error) throw new Error(`raw_posts lookup failed: ${error.message}`);
  const row = data as unknown as RawPostRow & { sources: { name: string } | null };
  return { id: row.id, post_text: row.post_text, source_id: row.source_id, source_name: row.sources?.name ?? "unknown" };
}

export async function completeJob(
  db: SupabaseClient,
  args: {
    jobId: string; msgId: number; rawPostId: string; requestId: string; processingToken: string | null;
    themeScores: Record<string, number>; reason: string; providerResponse?: unknown;
  },
): Promise<"inserted" | "duplicate" | "superseded"> {
  const { data, error } = await db.rpc("complete_scoring_job", {
    p_job_id: args.jobId,
    p_msg_id: args.msgId,
    p_raw_post_id: args.rawPostId,
    p_scoring_request_id: args.requestId,
    p_theme_scores: args.themeScores,
    p_reason: args.reason,
    p_provider_response: args.providerResponse ?? null,
    p_processing_token: args.processingToken,
  });
  if (error) throw new Error(`complete_scoring_job failed: ${error.message}`);
  return data as "inserted" | "duplicate" | "superseded";
}

export async function recordFailure(
  db: SupabaseClient,
  args: {
    jobId: string; msgId: number; rawPostId: string; requestId: string; processingToken: string | null;
    failureType: string; errorCode?: string; errorMessage?: string; providerResponse?: unknown;
  },
): Promise<"retry" | "dead_letter" | "superseded" | "circuit_break"> {
  const { data, error } = await db.rpc("record_scoring_failure", {
    p_job_id: args.jobId,
    p_msg_id: args.msgId,
    p_raw_post_id: args.rawPostId,
    p_scoring_request_id: args.requestId,
    p_failure_type: args.failureType,
    p_error_code: args.errorCode ?? null,
    p_error_message: args.errorMessage?.slice(0, 500) ?? null,
    p_provider_response: args.providerResponse ?? null,
    p_processing_token: args.processingToken,
  });
  if (error) throw new Error(`record_scoring_failure failed: ${error.message}`);
  return data as "retry" | "dead_letter" | "superseded" | "circuit_break";
}

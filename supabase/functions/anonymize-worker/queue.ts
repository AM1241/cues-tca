/** anonymize_jobs queue wrappers. See supabase/migrations/0014_anonymize_schema.sql. */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import type { Replacement } from "./deterministic.ts";

export interface QueueMessage {
  msg_id: number;
  message: { job_id: string; raw_post_id: string };
  /** Lease token stamped when this batch claimed the job (mirrors score-worker's 0009 lease). */
  processing_token: string | null;
}

/** Generous relative to a deterministic pass + one LLM call; mirrors score-worker's VT. */
export const VISIBILITY_TIMEOUT_SECONDS = 120;

export async function readJobs(
  db: SupabaseClient,
  qty: number,
  vt: number = VISIBILITY_TIMEOUT_SECONDS,
): Promise<QueueMessage[]> {
  const { data, error } = await db.rpc("read_anonymize_jobs", { p_vt: vt, p_qty: qty });
  if (error) throw new Error(`read_anonymize_jobs failed: ${error.message}`);
  return (data ?? []) as QueueMessage[];
}

export interface RawPostForAnonymize {
  id: string;
  post_text: string;
  source_name: string;
}

export async function getRawPost(db: SupabaseClient, rawPostId: string): Promise<RawPostForAnonymize> {
  const { data, error } = await db
    .from("raw_posts")
    .select("id, post_text, sources(name)")
    .eq("id", rawPostId)
    .single();
  if (error) throw new Error(`raw_posts lookup failed: ${error.message}`);
  const row = data as unknown as { id: string; post_text: string; sources: { name: string } | null };
  return { id: row.id, post_text: row.post_text, source_name: row.sources?.name ?? "unknown" };
}

export interface ConfigRow {
  anonymization_enabled: boolean;
  anonymize_companies: boolean;
  keep_public_bodies: boolean;
  company_aliases: Record<string, string>;
  min_relevance_score: number;
}

export async function getConfig(db: SupabaseClient): Promise<ConfigRow> {
  const { data, error } = await db
    .from("configurations")
    .select("anonymization_enabled, anonymize_companies, keep_public_bodies, company_aliases, min_relevance_score")
    .eq("id", "default")
    .single();
  if (error) throw new Error(`configurations lookup failed: ${error.message}`);
  return data as unknown as ConfigRow;
}

export async function completeJob(
  db: SupabaseClient,
  args: {
    jobId: string; msgId: number; rawPostId: string; processingToken: string | null;
    anonymizedText: string; replacements: Replacement[]; generalizedSourceName: string;
    configSnapshot: Record<string, unknown>; providerResponse?: unknown;
  },
): Promise<"inserted" | "duplicate" | "superseded"> {
  const { data, error } = await db.rpc("complete_anonymize_job", {
    p_job_id: args.jobId,
    p_msg_id: args.msgId,
    p_raw_post_id: args.rawPostId,
    p_anonymized_text: args.anonymizedText,
    p_replacements: args.replacements,
    p_generalized_source_name: args.generalizedSourceName,
    p_entity_extraction_used: true,
    p_config_snapshot: args.configSnapshot,
    p_provider_response: args.providerResponse ?? null,
    p_processing_token: args.processingToken,
  });
  if (error) throw new Error(`complete_anonymize_job failed: ${error.message}`);
  return data as "inserted" | "duplicate" | "superseded";
}

export async function recordFailure(
  db: SupabaseClient,
  args: {
    jobId: string; msgId: number; rawPostId: string; processingToken: string | null;
    failureType: string; errorCode?: string; errorMessage?: string; providerResponse?: unknown;
  },
): Promise<"retry" | "dead_letter" | "superseded"> {
  const { data, error } = await db.rpc("record_anonymize_failure", {
    p_job_id: args.jobId,
    p_msg_id: args.msgId,
    p_raw_post_id: args.rawPostId,
    p_failure_type: args.failureType,
    p_error_code: args.errorCode ?? null,
    p_error_message: args.errorMessage?.slice(0, 500) ?? null,
    p_provider_response: args.providerResponse ?? null,
    p_processing_token: args.processingToken,
  });
  if (error) throw new Error(`record_anonymize_failure failed: ${error.message}`);
  return data as "retry" | "dead_letter" | "superseded";
}

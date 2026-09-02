/** Data access for the generate function. See supabase/migrations/0016_generation.sql. */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";

export interface GenerationConfigRow {
  themes: unknown;
  voice_tone: string | null;
  voice_audience: string | null;
  voice_style: string | null;
  /** The operator's editorial scope — see 0019_editorial_domain.sql. */
  editorial_domain: string | null;
  /** Mirrors what the anonymiser replaced company names with. */
  domain_generic_entity: string | null;
}

export async function getConfig(db: SupabaseClient): Promise<GenerationConfigRow> {
  const { data, error } = await db
    .from("configurations")
    .select("themes, voice_tone, voice_audience, voice_style, editorial_domain, domain_generic_entity")
    .eq("id", "default")
    .single();
  if (error) throw new Error(`configurations lookup failed: ${error.message}`);
  return data as unknown as GenerationConfigRow;
}

export interface ClusteringRunRow {
  id: string;
  status: string;
}

export async function getClusteringRun(db: SupabaseClient, runId: string): Promise<ClusteringRunRow | null> {
  const { data, error } = await db
    .from("clustering_runs")
    .select("id, status")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw new Error(`clustering_runs lookup failed: ${error.message}`);
  return data as unknown as ClusteringRunRow | null;
}

export interface ClusterRow {
  id: string;
  clustering_run_id: string;
  label: string;
  label_failed: boolean;
  post_count: number;
}

export async function getClusters(db: SupabaseClient, clusterIds: string[]): Promise<Map<string, ClusterRow>> {
  if (clusterIds.length === 0) return new Map();
  const { data, error } = await db
    .from("clusters")
    .select("id, clustering_run_id, label, label_failed, post_count")
    .in("id", clusterIds);
  if (error) throw new Error(`clusters lookup failed: ${error.message}`);
  const map = new Map<string, ClusterRow>();
  for (const row of (data ?? []) as unknown as ClusterRow[]) map.set(row.id, row);
  return map;
}

export interface ClusterPostInput {
  raw_post_id: string;
  anonymize_result_id: string;
  anonymized_text: string;
  generalized_source_name: string;
}

/**
 * The exact posts assigned to one cluster within one run, joined through
 * cluster_assignments -> clustering_run_posts for the anonymize_result_id
 * pinned at clustering time, then to anonymize_results for the text that
 * result actually produced — NOT anonymized_posts_current, which is
 * overwrite-in-place and could have moved on since the run. This is what
 * makes a generation result's traceability exact even after a later
 * re-anonymisation.
 */
export async function getClusterPostInputs(db: SupabaseClient, runId: string, clusterId: string): Promise<ClusterPostInput[]> {
  const { data: assignments, error: assignErr } = await db
    .from("cluster_assignments")
    .select("raw_post_id")
    .eq("cluster_id", clusterId)
    .eq("clustering_run_id", runId);
  if (assignErr) throw new Error(`cluster_assignments lookup failed: ${assignErr.message}`);
  const rawPostIds = ((assignments ?? []) as unknown as { raw_post_id: string }[]).map((r) => r.raw_post_id);
  if (rawPostIds.length === 0) return [];

  const { data: runPosts, error: runPostsErr } = await db
    .from("clustering_run_posts")
    .select("raw_post_id, anonymize_result_id")
    .eq("clustering_run_id", runId)
    .in("raw_post_id", rawPostIds);
  if (runPostsErr) throw new Error(`clustering_run_posts lookup failed: ${runPostsErr.message}`);
  const resultIdByPost = new Map(
    ((runPosts ?? []) as unknown as { raw_post_id: string; anonymize_result_id: string }[])
      .map((r) => [r.raw_post_id, r.anonymize_result_id]),
  );

  const resultIds = [...resultIdByPost.values()];
  if (resultIds.length === 0) return [];

  const { data: results, error: resultsErr } = await db
    .from("anonymize_results")
    .select("id, raw_post_id, anonymized_text, generalized_source_name")
    .in("id", resultIds);
  if (resultsErr) throw new Error(`anonymize_results lookup failed: ${resultsErr.message}`);
  const textById = new Map(
    ((results ?? []) as unknown as { id: string; raw_post_id: string; anonymized_text: string; generalized_source_name: string }[])
      .map((r) => [r.id, r]),
  );

  const out: ClusterPostInput[] = [];
  for (const rawPostId of rawPostIds) {
    const resultId = resultIdByPost.get(rawPostId);
    const result = resultId ? textById.get(resultId) : undefined;
    if (!resultId || !result) continue; // no valid anonymisation result — excluded, not fabricated
    out.push({
      raw_post_id: rawPostId,
      anonymize_result_id: resultId,
      anonymized_text: result.anonymized_text,
      generalized_source_name: result.generalized_source_name,
    });
  }
  return out;
}

export interface PreviousResultRow {
  id: string;
  cluster_id: string;
  clustering_run_id: string;
  output_types: string[];
  post_output: unknown;
  carousel_output: unknown;
}

/** The draft a regeneration is trying to improve on. */
export async function getGenerationResult(
  db: SupabaseClient,
  resultId: string,
): Promise<PreviousResultRow | null> {
  const { data, error } = await db
    .from("cluster_generation_results")
    .select("id, cluster_id, clustering_run_id, output_types, post_output, carousel_output")
    .eq("id", resultId)
    .maybeSingle();
  if (error) throw new Error(`cluster_generation_results lookup failed: ${error.message}`);
  return data as unknown as PreviousResultRow | null;
}

/**
 * Records that a newer draft answers this review row. Never fatal to the
 * caller: the regeneration itself has already succeeded and been persisted by
 * the time this runs, so a failure here must not turn a good result into an
 * error — it only leaves the old row unlinked. See 0023.
 */
export async function supersedeReview(
  db: SupabaseClient,
  args: { oldResultId: string; outputType: string; newResultId: string },
): Promise<void> {
  const { error } = await db.rpc("supersede_generation_review", {
    p_old_result_id: args.oldResultId,
    p_output_type: args.outputType,
    p_new_result_id: args.newResultId,
  });
  if (error) throw new Error(`supersede_generation_review failed: ${error.message}`);
}

export async function createGenerationRequest(
  db: SupabaseClient,
  args: {
    clusteringRunId: string;
    requestedClusterIds: string[];
    outputTypes: string[];
    feedback?: string | null;
    regeneratesResultId?: string | null;
  },
): Promise<string> {
  const { data, error } = await db.rpc("create_cluster_generation_request", {
    p_clustering_run_id: args.clusteringRunId,
    p_requested_cluster_ids: args.requestedClusterIds,
    p_output_types: args.outputTypes,
    p_feedback: args.feedback ?? null,
    p_regenerates_result_id: args.regeneratesResultId ?? null,
  });
  if (error) throw new Error(`create_cluster_generation_request failed: ${error.message}`);
  return data as string;
}

export async function recordGenerationError(
  db: SupabaseClient,
  args: { requestId: string; clusterId: string; errorType: string; errorMessage: string },
): Promise<void> {
  const { error } = await db.rpc("record_cluster_generation_error", {
    p_request_id: args.requestId,
    p_cluster_id: args.clusterId,
    p_error_type: args.errorType,
    p_error_message: args.errorMessage.slice(0, 2000),
  });
  if (error) throw new Error(`record_cluster_generation_error failed: ${error.message}`);
}

export interface CompleteResultArgs {
  requestId: string;
  clusterId: string;
  clusterLabel: string;
  rawPostIds: string[];
  anonymizeResultIds: string[];
  outputTypes: string[];
  postOutput: Record<string, unknown> | null;
  carouselOutput: Record<string, unknown> | null;
  configSnapshot: Record<string, unknown>;
  promptVersion: string;
  promptHash: string;
  model: string;
  providerResponse?: unknown;
}

export async function completeGenerationResult(db: SupabaseClient, args: CompleteResultArgs): Promise<string> {
  const { data, error } = await db.rpc("complete_cluster_generation_result", {
    p_request_id: args.requestId,
    p_cluster_id: args.clusterId,
    p_cluster_label: args.clusterLabel,
    p_raw_post_ids: args.rawPostIds,
    p_anonymize_result_ids: args.anonymizeResultIds,
    p_output_types: args.outputTypes,
    p_post_output: args.postOutput,
    p_carousel_output: args.carouselOutput,
    p_config_snapshot: args.configSnapshot,
    p_prompt_version: args.promptVersion,
    p_prompt_hash: args.promptHash,
    p_model: args.model,
    p_provider_response: args.providerResponse ?? null,
  });
  if (error) throw new Error(`complete_cluster_generation_result failed: ${error.message}`);
  return data as string;
}

export async function finishGenerationRequest(db: SupabaseClient, requestId: string): Promise<string> {
  const { data, error } = await db.rpc("finish_cluster_generation_request", { p_request_id: requestId });
  if (error) throw new Error(`finish_cluster_generation_request failed: ${error.message}`);
  return data as string;
}

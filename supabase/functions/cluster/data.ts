/** Data access for the cluster function. See supabase/migrations/0015_clustering.sql. */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";

export interface ClusterConfigRow {
  /** Operator's scope and angles, so cluster names are not written for food
   *  when the tool is pointed elsewhere. See 0019_editorial_domain.sql. */
  editorial_domain: string | null;
  themes: unknown;
  min_relevance_score: number;
  cluster_similarity_threshold: number;
  min_cluster_size: number;
}

export async function getConfig(db: SupabaseClient): Promise<ClusterConfigRow> {
  const { data, error } = await db
    .from("configurations")
    .select("min_relevance_score, cluster_similarity_threshold, min_cluster_size, editorial_domain, themes")
    .eq("id", "default")
    .single();
  if (error) throw new Error(`configurations lookup failed: ${error.message}`);
  return data as unknown as ClusterConfigRow;
}

export interface EligiblePost {
  raw_post_id: string;
  /** The exact anonymize_results row this post's current text came from —
   * embeddings and the run's input-set record are keyed off this, not just
   * raw_post_id, so a later re-anonymisation can't silently invalidate or
   * misattribute history. */
  anonymize_result_id: string;
  anonymized_text: string;
  overall_relevance: number;
}

/**
 * Posts eligible for a clustering run: a successful current anonymised
 * result, above the relevance threshold, published inside the requested
 * window. Matches PHASE4_REQUIREMENTS.md §3's input-scope rules exactly.
 *
 * Ordered by raw_post_id — the caller (grouping.ts) depends on receiving a
 * stable, deterministic order before running the order-sensitive greedy
 * grouping algorithm; without this, the same eligible set could cluster
 * differently between two runs for reasons having nothing to do with the
 * data itself.
 */
export async function getEligiblePosts(
  db: SupabaseClient,
  periodStart: string,
  periodEnd: string,
  minRelevance: number,
): Promise<EligiblePost[]> {
  const { data, error } = await db
    .from("anonymized_posts_current")
    .select("raw_post_id, current_result_id, anonymized_text, overall_relevance, raw_posts!inner(published_at)")
    .not("current_result_id", "is", null)
    .gte("overall_relevance", minRelevance)
    .gte("raw_posts.published_at", periodStart)
    .lte("raw_posts.published_at", periodEnd)
    .order("raw_post_id", { ascending: true });
  if (error) throw new Error(`anonymized_posts_current lookup failed: ${error.message}`);
  return ((data ?? []) as unknown as { raw_post_id: string; current_result_id: string; anonymized_text: string; overall_relevance: number }[])
    .map(({ raw_post_id, current_result_id, anonymized_text, overall_relevance }) => ({
      raw_post_id, anonymize_result_id: current_result_id, anonymized_text, overall_relevance,
    }));
}

export interface ExistingEmbedding {
  anonymize_result_id: string;
  embedding: number[];
}

/** Parses pgvector's text wire format ("[0.1,0.2,...]") back into a plain array. */
function parseVectorLiteral(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  const s = String(raw);
  return s.slice(1, -1).split(",").map(Number);
}

/**
 * Looks up existing embeddings by (anonymize_result_id, model) — the table's
 * actual identity. A post whose current anonymisation changed, or whose
 * embedding was computed under a different model, has no matching row here
 * and must be re-embedded; there is nothing to explicitly invalidate.
 */
export async function getExistingEmbeddings(
  db: SupabaseClient,
  anonymizeResultIds: string[],
  model: string,
): Promise<Map<string, number[]>> {
  if (anonymizeResultIds.length === 0) return new Map();
  const { data, error } = await db
    .from("post_embeddings")
    .select("anonymize_result_id, embedding")
    .in("anonymize_result_id", anonymizeResultIds)
    .eq("model", model);
  if (error) throw new Error(`post_embeddings lookup failed: ${error.message}`);
  const map = new Map<string, number[]>();
  for (const row of (data ?? []) as unknown as ExistingEmbedding[]) {
    map.set(row.anonymize_result_id, parseVectorLiteral(row.embedding));
  }
  return map;
}

export async function upsertEmbedding(
  db: SupabaseClient,
  anonymizeResultId: string,
  rawPostId: string,
  embedding: number[],
  model: string,
): Promise<void> {
  const { error } = await db.rpc("upsert_post_embedding", {
    p_anonymize_result_id: anonymizeResultId,
    p_raw_post_id: rawPostId,
    p_embedding: JSON.stringify(embedding),
    p_model: model,
  });
  if (error) throw new Error(`upsert_post_embedding failed: ${error.message}`);
}

export async function createClusteringRun(
  db: SupabaseClient,
  args: {
    periodStart: string; periodEnd: string; minRelevanceScore: number;
    clusterSimilarityThreshold: number; minClusterSize: number; embeddingModel: string;
  },
): Promise<string> {
  const { data, error } = await db.rpc("create_clustering_run", {
    p_period_start: args.periodStart,
    p_period_end: args.periodEnd,
    p_min_relevance_score: args.minRelevanceScore,
    p_cluster_similarity_threshold: args.clusterSimilarityThreshold,
    p_min_cluster_size: args.minClusterSize,
    p_embedding_model: args.embeddingModel,
  });
  if (error) throw new Error(`create_clustering_run failed: ${error.message}`);
  return data as string;
}

export async function recordClusteringRunInput(
  db: SupabaseClient,
  runId: string,
  input: { rawPostId: string; anonymizeResultId: string }[],
): Promise<void> {
  const { error } = await db.rpc("record_clustering_run_input", {
    p_run_id: runId,
    p_input: input.map((i) => ({ raw_post_id: i.rawPostId, anonymize_result_id: i.anonymizeResultId })),
  });
  if (error) throw new Error(`record_clustering_run_input failed: ${error.message}`);
}

export interface ClusterInput {
  label: string;
  label_failed: boolean;
  post_ids: string[];
}

export async function completeClusteringRun(db: SupabaseClient, runId: string, clusters: ClusterInput[]): Promise<void> {
  const { error } = await db.rpc("complete_clustering_run", { p_run_id: runId, p_clusters: clusters });
  if (error) throw new Error(`complete_clustering_run failed: ${error.message}`);
}

export async function failClusteringRun(db: SupabaseClient, runId: string, message: string): Promise<void> {
  const { error } = await db.rpc("fail_clustering_run", { p_run_id: runId, p_error_message: message.slice(0, 500) });
  if (error) throw new Error(`fail_clustering_run failed: ${error.message}`);
}

/**
 * Records what happened when this run tried to obtain an embedding for one
 * input post — cached-reuse and freshly-computed both count as 'embedded';
 * any embedding-call failure is 'failed' with its error message. Persists
 * independently of the run's overall outcome, so a partial failure stays
 * queryable on clustering_run_posts long after this HTTP response is gone.
 */
export async function recordEmbeddingOutcome(
  db: SupabaseClient,
  runId: string,
  rawPostId: string,
  status: "embedded" | "failed",
  errorMessage?: string,
): Promise<void> {
  const { error } = await db.rpc("record_embedding_outcome", {
    p_run_id: runId,
    p_raw_post_id: rawPostId,
    p_status: status,
    p_error_message: errorMessage?.slice(0, 500) ?? null,
  });
  if (error) throw new Error(`record_embedding_outcome failed: ${error.message}`);
}

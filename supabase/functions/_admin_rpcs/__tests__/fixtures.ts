/**
 * Shared fixture builders for the admin-RPC test suites (purge_source,
 * admin_delete_generation_result). Both need the same real pipeline history
 * — a scored, anonymised, embedded, clustered post — built the same way the
 * real score-worker/anonymize-worker/cluster functions do it: through the
 * SECURITY DEFINER RPCs, never a raw insert, because every table on this
 * path grants service_role SELECT only (see each helper's own comment for
 * the specific migration that says so).
 */
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";

export const URL_ = Deno.env.get("SUPABASE_URL");
export const ANON = Deno.env.get("SUPABASE_ANON_KEY");
export const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
export const LIVE = Boolean(URL_ && ANON && SERVICE);

// service_role: fixture setup + teardown only. purge_source and
// admin_delete_generation_result are both is_admin()-gated on auth.uid(),
// which never resolves for the service-role key — real assertions against
// either RPC always go through actingAs(), a client signed in as a real user.
export const db: SupabaseClient = LIVE
  ? createClient(URL_!, SERVICE!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

/** A client acting as one real signed-in user — what an admin-gated RPC actually sees. */
export function actingAs(token: string): SupabaseClient {
  return createClient(URL_!, ANON!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export const PW = "test-password-123!";

export async function makeUser(
  email: string, role: "admin" | "editor" | null,
  tokens: Record<string, string>, userIds: string[],
): Promise<void> {
  const { data, error } = await db.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw error;
  userIds.push(data.user!.id);
  if (role) {
    const { error: e2 } = await db.from("editors").insert({ user_id: data.user!.id, email, role });
    if (e2) throw e2;
  }
  const anon = createClient(URL_!, ANON!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data: session, error: e3 } = await anon.auth.signInWithPassword({ email, password: PW });
  if (e3) throw e3;
  tokens[email] = session.session!.access_token;
}

export async function makeSource(name: string): Promise<string> {
  const { data, error } = await db.from("sources")
    .insert({ name, source_type: "linkedin", url: "https://example.test", enabled: true })
    .select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function makeRawPost(sourceId: string, text = "a test post about food and agriculture"): Promise<string> {
  const { data, error } = await db.from("raw_posts").insert({
    source_id: sourceId, source_url: `https://example.test/${crypto.randomUUID()}`,
    external_post_id: crypto.randomUUID(), post_text: text, published_at: new Date().toISOString(),
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export const CONFIG_SNAPSHOT = { themes: [{ theme_id: "t1", label: "t1", position: 1 }], min_relevance_score: 50 };

// scoring_results / scoring_job_state / scoring_dead_letter grant service_role
// SELECT only (0005) — every write below goes through the RPCs.
export async function makeScoringRequest(): Promise<string> {
  const { data: reqId, error } = await db.rpc("create_scoring_request", {
    p_purpose: "evaluation", p_prompt_version: "v1", p_prompt_hash: "h",
    p_config_snapshot: CONFIG_SNAPSHOT, p_model: "gpt-test", p_model_snapshot: "gpt-test-2026",
    p_aggregation_strategy: "max_theme_v1",
  });
  if (error) throw error;
  const { error: e2 } = await db.rpc("activate_scoring_request", { p_request_id: reqId });
  if (e2) throw e2;
  return reqId as string;
}

async function claimScoringJob(rawPostId: string, requestId: string) {
  const { data: jobId, error } = await db.rpc("enqueue_scoring_job", {
    p_raw_post_id: rawPostId, p_scoring_request_id: requestId,
  });
  if (error) throw error;
  const { data: claimed, error: e2 } = await db.rpc("read_scoring_jobs", { p_vt: 120, p_qty: 200 });
  if (e2) throw e2;
  const mine = (claimed as { msg_id: number; message: { job_id: string }; processing_token: string }[])
    .find((m) => m.message.job_id === jobId);
  if (!mine) throw new Error("scoring job was not claimable right after enqueue");
  return { jobId: jobId as string, msgId: mine.msg_id, token: mine.processing_token };
}

/** Scores and promotes to analyzed_posts in one call — the real worker path (0018). */
export async function scoreAndPromote(rawPostId: string, requestId: string): Promise<void> {
  const { jobId, msgId, token } = await claimScoringJob(rawPostId, requestId);
  const { error } = await db.rpc("complete_and_promote_scoring_job", {
    p_job_id: jobId, p_msg_id: msgId, p_raw_post_id: rawPostId, p_scoring_request_id: requestId,
    p_theme_scores: { t1: 80 }, p_reason: "test", p_processing_token: token,
  });
  if (error) throw error;
}

/** Scores, then dead-letters directly — one call; the 3-strike escalation
 * itself is score-worker's own suite's concern, not this one's. */
export async function scoreAndDeadLetter(rawPostId: string, requestId: string): Promise<void> {
  const { jobId, msgId } = await claimScoringJob(rawPostId, requestId);
  const { error } = await db.rpc("dead_letter_scoring_job", {
    p_job_id: jobId, p_msg_id: msgId, p_raw_post_id: rawPostId, p_scoring_request_id: requestId,
    p_failure_type: "server_error", p_error_code: null, p_error_message: "fixture failure", p_provider_response: null, p_attempts: 3,
  });
  if (error) throw error;
}

// anonymize_results / anonymize_job_state / anonymize_dead_letter grant
// service_role SELECT only (0014) — every write below goes through the RPCs.
async function claimAnonymizeJob(rawPostId: string) {
  const { error: bfErr } = await db.rpc("backfill_anonymize_jobs", { p_min_relevance: 0 });
  if (bfErr) throw bfErr;
  const { data: claimed, error } = await db.rpc("read_anonymize_jobs", { p_vt: 120, p_qty: 200 });
  if (error) throw error;
  const mine = (claimed as { msg_id: number; message: { job_id: string; raw_post_id: string }; processing_token: string }[])
    .find((m) => m.message.raw_post_id === rawPostId);
  if (!mine) {
    throw new Error(`anonymize job for ${rawPostId} was not claimable — is the post scored+promoted?`);
  }
  return { jobId: mine.message.job_id, msgId: mine.msg_id, token: mine.processing_token };
}

export async function anonymizeAndComplete(rawPostId: string): Promise<string> {
  const { jobId, msgId, token } = await claimAnonymizeJob(rawPostId);
  const { error } = await db.rpc("complete_anonymize_job", {
    p_job_id: jobId, p_msg_id: msgId, p_raw_post_id: rawPostId,
    p_anonymized_text: "anonymised test text", p_replacements: [], p_generalized_source_name: "a food-sector organization",
    p_entity_extraction_used: true, p_config_snapshot: {}, p_processing_token: token,
  });
  if (error) throw error;
  const { data: result, error: e2 } = await db.from("anonymize_results").select("id")
    .eq("raw_post_id", rawPostId).order("created_at", { ascending: false }).limit(1).single();
  if (e2) throw e2;
  return result!.id as string;
}

export async function anonymizeAndDeadLetter(rawPostId: string): Promise<void> {
  const { jobId, msgId } = await claimAnonymizeJob(rawPostId);
  const { error } = await db.rpc("dead_letter_anonymize_job", {
    p_job_id: jobId, p_msg_id: msgId, p_raw_post_id: rawPostId,
    p_failure_type: "server_error", p_error_code: null, p_error_message: "fixture failure", p_provider_response: null, p_attempts: 3,
  });
  if (error) throw error;
}

function fakeEmbedding(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => Math.sin(seed * 7919 + i) * 0.01);
}

// post_embeddings / clustering_runs / clustering_run_posts / clusters grant
// service_role SELECT only (0015) — every write below goes through the RPCs.
let embedSeed = 0;

/** Embeds one post into its own single-post clustering run — everything
 * purge_source's clustering_run_posts delete needs to exist for real. */
export async function embedIntoNewRun(rawPostId: string, anonymizeResultId: string, model = "text-embedding-test"): Promise<string> {
  const { data: runId, error } = await db.rpc("create_clustering_run", {
    p_period_start: "2020-01-01T00:00:00Z", p_period_end: "2030-01-01T00:00:00Z",
    p_min_relevance_score: 50, p_cluster_similarity_threshold: 0.75, p_min_cluster_size: 1, p_embedding_model: model,
  });
  if (error) throw error;
  const { error: e2 } = await db.rpc("record_clustering_run_input", {
    p_run_id: runId, p_input: [{ raw_post_id: rawPostId, anonymize_result_id: anonymizeResultId }],
  });
  if (e2) throw e2;
  embedSeed += 1;
  const { error: e3 } = await db.rpc("upsert_post_embedding", {
    p_anonymize_result_id: anonymizeResultId, p_raw_post_id: rawPostId, p_embedding: fakeEmbedding(embedSeed), p_model: model,
  });
  if (e3) throw e3;
  const { error: e4 } = await db.rpc("record_embedding_outcome", { p_run_id: runId, p_raw_post_id: rawPostId, p_status: "embedded" });
  if (e4) throw e4;
  return runId as string;
}

/** Turns a running, embedded run into a real `clusters` row citing the post. */
export async function completeIntoOneCluster(runId: string, rawPostId: string, label = "test cluster"): Promise<string> {
  const { error } = await db.rpc("complete_clustering_run", {
    p_run_id: runId, p_clusters: [{ label, label_failed: false, post_ids: [rawPostId] }],
  });
  if (error) throw error;
  const { data: cluster, error: e2 } = await db.from("clusters").select("id").eq("clustering_run_id", runId).single();
  if (e2) throw e2;
  return cluster!.id as string;
}

/** Builds one raw_post, fully scored/anonymised/embedded/clustered into its
 * own single-cluster run. Returns everything a caller needs to then create a
 * cluster_generation_results row citing it. */
export async function buildClusteredPost(sourceId: string, label: string): Promise<{ rawPostId: string; clusteringRunId: string; clusterId: string }> {
  const requestId = await makeScoringRequest();
  const rawPostId = await makeRawPost(sourceId, `post for ${label}`);
  await scoreAndPromote(rawPostId, requestId);
  const anonymizeResultId = await anonymizeAndComplete(rawPostId);
  const clusteringRunId = await embedIntoNewRun(rawPostId, anonymizeResultId);
  const clusterId = await completeIntoOneCluster(clusteringRunId, rawPostId, label);
  return { rawPostId, clusteringRunId, clusterId };
}

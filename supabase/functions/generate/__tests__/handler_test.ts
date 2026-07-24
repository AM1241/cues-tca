/**
 * Whole-flow tests for the generate handler against the LOCAL Supabase stack.
 * OpenAI is always scripted; OPENAI_API_KEY is set to a dummy value precisely
 * so a real call would fail loudly rather than quietly succeed.
 *
 * Sized to the Phase 5 spec's "no more than 6 test steps" bar:
 *   1. authentication and invalid request
 *   2. cluster/run mismatch rejected
 *   3. label_failed cluster rejected
 *   4. successful scripted generation writes immutable request/results
 *   5. exact traceability snapshot is persisted
 *   6. LLM failure produces a failed request and no fake successful result
 *
 * Run (from the repo root):
 *   deno test --allow-env --allow-net supabase/functions/generate/__tests__/
 *   (with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY=dummy /
 *   INGEST_INTERNAL_SECRET set, same as the Phase 4 suites)
 *
 * Skipped automatically when SUPABASE_URL is absent.
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handleGenerate } from "../index.ts";
import { scriptedGeneration } from "./fixtures.ts";
import { handleCluster } from "../../cluster/index.ts";
import { scriptedEmbedding, scriptedLabel, tileVector } from "../../cluster/__tests__/fixtures.ts";

const URL_ = Deno.env.get("SUPABASE_URL");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const LIVE = Boolean(URL_ && SERVICE);
const INTERNAL_SECRET = Deno.env.get("INGEST_INTERNAL_SECRET") ?? "";

const db: SupabaseClient = LIVE
  ? createClient(URL_!, SERVICE!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

const runTag = `T-gen-${Date.now()}-${crypto.randomUUID()}`;
let sourceId = "";
const rawPostIds: string[] = [];
let hadDefaultConfig = false;

function request(body: unknown, apikey?: string): Request {
  return new Request("https://local.test/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apikey ? { apikey } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/** Score a raw_post via the real scoring RPC chain, same fixture shape as
 *  cluster/anonymize-worker's own suites — service_role has no direct INSERT
 *  on scoring_results, everything must go through the real RPCs. */
async function makeScoredPost(text: string, overallRelevance = 80, publishedAt?: string): Promise<string> {
  const { data: rp, error: rpErr } = await db
    .from("raw_posts")
    .insert({
      source_id: sourceId,
      source_url: `https://example.test/post-${crypto.randomUUID()}`,
      external_post_id: crypto.randomUUID(),
      post_text: text,
      published_at: publishedAt ?? new Date().toISOString(),
    })
    .select("id").single();
  if (rpErr) throw rpErr;
  const rawPostId = rp.id as string;
  rawPostIds.push(rawPostId);

  const { data: reqId, error: reqErr } = await db.rpc("create_scoring_request", {
    p_purpose: "evaluation", p_prompt_version: "scoring_v1", p_prompt_hash: "test-hash",
    p_config_snapshot: { themes: [{ theme_id: "sustainability", label: "sustainability", position: 1 }], min_relevance_score: 50 },
    p_model: "gpt-test", p_model_snapshot: "gpt-test-2026-01-01", p_aggregation_strategy: "max_theme_v1",
  });
  if (reqErr) throw reqErr;
  await db.rpc("activate_scoring_request", { p_request_id: reqId });

  const { data: jobId, error: enqErr } = await db.rpc("enqueue_scoring_job", {
    p_raw_post_id: rawPostId, p_scoring_request_id: reqId,
  });
  if (enqErr) throw enqErr;
  const { data: claimed, error: claimErr } = await db.rpc("read_scoring_jobs", { p_vt: 120, p_qty: 50 });
  if (claimErr) throw claimErr;
  const mine = (claimed as { msg_id: number; message: { job_id: string }; processing_token: string }[])
    .find((m) => m.message.job_id === jobId)!;
  const { error: completeErr } = await db.rpc("complete_scoring_job", {
    p_job_id: jobId, p_msg_id: mine.msg_id, p_raw_post_id: rawPostId, p_scoring_request_id: reqId,
    p_theme_scores: { sustainability: overallRelevance }, p_reason: "test fixture",
    p_processing_token: mine.processing_token,
  });
  if (completeErr) throw completeErr;

  const { data: scoreRow, error: scoreRowErr } = await db
    .from("scoring_results").select("id").eq("raw_post_id", rawPostId).eq("scoring_request_id", reqId).single();
  if (scoreRowErr) throw scoreRowErr;
  await db.rpc("set_current_scoring_result", { p_raw_post_id: rawPostId, p_result_id: scoreRow!.id });
  await db.rpc("close_scoring_request", { p_request_id: reqId });

  return rawPostId;
}

/** Score + anonymise a post via the real RPC chains end to end, same as
 *  cluster's own suite. Returns the raw_post_id and the exact
 *  anonymize_results.id produced. */
async function makeAnonymisedPost(text: string, overallRelevance = 80, publishedAt?: string): Promise<{ rawPostId: string; resultId: string }> {
  const rawPostId = await makeScoredPost(text, overallRelevance, publishedAt);
  await db.rpc("backfill_anonymize_jobs", { p_min_relevance: null });
  const { data: claimed, error: claimErr } = await db.rpc("read_anonymize_jobs", { p_vt: 120, p_qty: 50 });
  if (claimErr) throw claimErr;
  const mine = (claimed as { msg_id: number; message: { job_id: string; raw_post_id: string }; processing_token: string }[])
    .find((m) => m.message.raw_post_id === rawPostId)!;
  const { error: completeErr } = await db.rpc("complete_anonymize_job", {
    p_job_id: mine.message.job_id, p_msg_id: mine.msg_id, p_raw_post_id: rawPostId,
    p_anonymized_text: text, p_replacements: [], p_generalized_source_name: "a food-sector organization",
    p_entity_extraction_used: true, p_config_snapshot: {}, p_processing_token: mine.processing_token,
  });
  if (completeErr) throw completeErr;

  const { data: apc, error: apcErr } = await db
    .from("anonymized_posts_current").select("current_result_id").eq("raw_post_id", rawPostId).single();
  if (apcErr) throw apcErr;
  return { rawPostId, resultId: apc!.current_result_id as string };
}

/** Runs the real cluster function (scripted embeddings/labels) over a tight
 *  window containing exactly the given posts, producing a real completed
 *  clustering_runs row with real clusters/cluster_assignments — the actual
 *  precondition generate operates on. */
async function makeCompletedRun(
  posts: { rawPostId: string; resultId: string; text: string }[],
  windowStart: string,
  windowEnd: string,
): Promise<{ runId: string; clusterId: string }> {
  const vec = tileVector([2, 2, 2]);
  const byInput: Record<string, { vector: number[] }> = {};
  for (const p of posts) byInput[p.text] = { vector: vec };
  const { callEmbeddingImpl } = scriptedEmbedding(byInput);
  const { callOpenAiImpl } = scriptedLabel({ label: "Test Editorial Theme" });

  const res = await handleCluster(
    request({ period_start: windowStart, period_end: windowEnd }, INTERNAL_SECRET),
    { db, callEmbeddingImpl, callOpenAiImpl },
  );
  const body = await res.json();
  if (!body.ok || !body.run_id) throw new Error(`makeCompletedRun: cluster call did not complete: ${JSON.stringify(body)}`);

  const { data: cluster, error: clusterErr } = await db
    .from("clusters").select("id").eq("clustering_run_id", body.run_id).limit(1).single();
  if (clusterErr) throw new Error(`makeCompletedRun: no cluster found on run ${body.run_id}: ${clusterErr.message}`);

  return { runId: body.run_id as string, clusterId: cluster!.id as string };
}

async function requireSchema() {
  for (const table of ["cluster_generation_requests", "cluster_generation_request_errors", "cluster_generation_results"]) {
    const { error } = await db.from(table).select("*", { head: true, count: "exact" });
    if (error) throw new Error(`required table public.${table} is missing or unreachable: ${error.message}`);
  }
}

async function setup() {
  await requireSchema();

  const { data: existing } = await db.from("configurations").select("id").eq("id", "default").maybeSingle();
  if (!existing) {
    const { error } = await db.from("configurations").insert({
      id: "default", min_relevance_score: 50,
      anonymization_enabled: true, anonymize_companies: true, keep_public_bodies: true,
      company_aliases: {}, cluster_similarity_threshold: 0.9, min_cluster_size: 2,
    });
    if (error) throw error;
    hadDefaultConfig = false;
  } else {
    hadDefaultConfig = true;
    const { error } = await db.from("configurations").update({ cluster_similarity_threshold: 0.9, min_cluster_size: 2 }).eq("id", "default");
    if (error) throw error;
  }

  const { data: src, error: srcErr } = await db
    .from("sources")
    .insert({ name: runTag, source_type: "linkedin", url: "https://example.test", enabled: true })
    .select("id").single();
  if (srcErr) throw srcErr;
  sourceId = src.id as string;
}

const FK_RESTRICT_VIOLATION = "23503";
const PERMISSION_DENIED = "42501";

async function teardown() {
  const failures: string[] = [];
  const retained: string[] = [];

  if (rawPostIds.length) {
    // cluster_generation_results/request_errors/requests have no service_role
    // DELETE grant (0016 mirrors 0014/0015's pattern) — immutable audit rows,
    // left in place deliberately.
    const { error: caErr } = await db.from("cluster_assignments").delete().in("raw_post_id", rawPostIds);
    if (caErr && caErr.code !== PERMISSION_DENIED) failures.push(`cluster_assignments cleanup: ${caErr.message}`);
    else if (caErr) retained.push("cluster_assignments: retained (service_role has no DELETE grant, 0015)");

    const { error: crpErr } = await db.from("clustering_run_posts").delete().in("raw_post_id", rawPostIds);
    if (crpErr && crpErr.code !== PERMISSION_DENIED) failures.push(`clustering_run_posts cleanup: ${crpErr.message}`);
    else if (crpErr) retained.push("clustering_run_posts: retained (service_role has no DELETE grant, 0015)");

    const { error: peErr } = await db.from("post_embeddings").delete().in("raw_post_id", rawPostIds);
    if (peErr && peErr.code !== PERMISSION_DENIED) failures.push(`post_embeddings cleanup: ${peErr.message}`);
    else if (peErr) retained.push("post_embeddings: retained (service_role has no DELETE grant, 0015)");

    const { error: apcErr } = await db.from("anonymized_posts_current").delete().in("raw_post_id", rawPostIds);
    if (apcErr) failures.push(`anonymized_posts_current cleanup: ${apcErr.message}`);

    const { error: rpErr } = await db.from("raw_posts").delete().in("id", rawPostIds);
    if (rpErr && rpErr.code !== FK_RESTRICT_VIOLATION) failures.push(`raw_posts cleanup: ${rpErr.message}`);
    else if (rpErr) retained.push("raw_posts: retained (FK-restrict from clustering_run_posts/cluster_assignments/anonymize_results)");
  }

  if (retained.length) {
    console.warn(`[generate teardown] retained-row report for run tag ${runTag}:\n  - ${retained.join("\n  - ")}`);
  }

  if (sourceId) {
    const { error: srcErr } = await db.from("sources").delete().eq("id", sourceId);
    if (srcErr && srcErr.code !== FK_RESTRICT_VIOLATION) failures.push(`sources cleanup: ${srcErr.message}`);
  }

  if (!hadDefaultConfig) {
    const { error: cfgErr } = await db.from("configurations").delete().eq("id", "default");
    if (cfgErr) failures.push(`configurations cleanup: ${cfgErr.message}`);
  }

  if (failures.length) throw new Error(`teardown hit unexpected errors:\n  - ${failures.join("\n  - ")}`);
}

Deno.test({
  name: "[generate] whole flow",
  ignore: !LIVE,
  async fn(t) {
    let sawFailure = false;
    async function runStep(name: string, fn: () => Promise<void>) {
      if (sawFailure) return;
      const ok = await t.step(name, fn);
      if (!ok) sawFailure = true;
    }

    const setupOk = await t.step("000 setup", setup);
    if (!setupOk) sawFailure = true;

    try {
      if (sawFailure) return;

      // =====================================================================
      // STEP 1 — AUTHENTICATION AND INVALID REQUEST
      // =====================================================================
      await runStep("no credentials -> 401", async () => {
        const res = await handleGenerate(
          request({ clustering_run_id: crypto.randomUUID(), cluster_ids: [crypto.randomUUID()] }),
          { db },
        );
        assertEquals(res.status, 401);
      });

      await runStep("missing cluster_ids -> 400", async () => {
        const res = await handleGenerate(
          request({ clustering_run_id: crypto.randomUUID() }, INTERNAL_SECRET),
          { db },
        );
        assertEquals(res.status, 400);
      });

      await runStep("invalid output_types -> 400", async () => {
        const res = await handleGenerate(
          request({ clustering_run_id: crypto.randomUUID(), cluster_ids: [crypto.randomUUID()], output_types: ["newsletter"] }, INTERNAL_SECRET),
          { db },
        );
        assertEquals(res.status, 400);
      });

      await runStep("unknown clustering_run_id -> 404", async () => {
        const res = await handleGenerate(
          request({ clustering_run_id: crypto.randomUUID(), cluster_ids: [crypto.randomUUID()] }, INTERNAL_SECRET),
          { db },
        );
        assertEquals(res.status, 404);
      });

      // =====================================================================
      // STEP 2 — CLUSTER/RUN MISMATCH REJECTED
      // =====================================================================
      let runA: { runId: string; clusterId: string } | null = null;
      let runB: { runId: string; clusterId: string } | null = null;

      await runStep("a cluster belonging to a DIFFERENT run is rejected", async () => {
        const anchorA = Date.now() - 40 * 60_000;
        const p1 = await makeAnonymisedPost(`${runTag} mismatch-A alpha.`, 80, new Date(anchorA).toISOString());
        const p2 = await makeAnonymisedPost(`${runTag} mismatch-A beta.`, 80, new Date(anchorA).toISOString());
        runA = await makeCompletedRun(
          [{ ...p1, text: `${runTag} mismatch-A alpha.` }, { ...p2, text: `${runTag} mismatch-A beta.` }],
          new Date(anchorA - 1000).toISOString(), new Date(anchorA + 1000).toISOString(),
        );

        const anchorB = Date.now() - 41 * 60_000;
        const p3 = await makeAnonymisedPost(`${runTag} mismatch-B alpha.`, 80, new Date(anchorB).toISOString());
        const p4 = await makeAnonymisedPost(`${runTag} mismatch-B beta.`, 80, new Date(anchorB).toISOString());
        runB = await makeCompletedRun(
          [{ ...p3, text: `${runTag} mismatch-B alpha.` }, { ...p4, text: `${runTag} mismatch-B beta.` }],
          new Date(anchorB - 1000).toISOString(), new Date(anchorB + 1000).toISOString(),
        );

        // runA's own run_id, but runB's cluster_id.
        const res = await handleGenerate(
          request({ clustering_run_id: runA.runId, cluster_ids: [runB!.clusterId] }, INTERNAL_SECRET),
          { db },
        );
        assertEquals(res.status, 422);

        const { count } = await db.from("cluster_generation_requests").select("*", { count: "exact", head: true }).eq("clustering_run_id", runA.runId);
        assertEquals(count, 0, "no request row was created for a rejected upfront mismatch");
      });

      // =====================================================================
      // STEP 3 — LABEL_FAILED CLUSTER REJECTED
      // =====================================================================
      await runStep("a label_failed cluster is rejected, recorded as an error, no fake output", async () => {
        const anchor = Date.now() - 42 * 60_000;
        const p1 = await makeAnonymisedPost(`${runTag} labelfail alpha.`, 80, new Date(anchor).toISOString());
        const p2 = await makeAnonymisedPost(`${runTag} labelfail beta.`, 80, new Date(anchor).toISOString());
        const vec = tileVector([3, 3, 3]);
        const { callEmbeddingImpl } = scriptedEmbedding({
          [`${runTag} labelfail alpha.`]: { vector: vec },
          [`${runTag} labelfail beta.`]: { vector: vec },
        });
        const { callOpenAiImpl } = scriptedLabel({ throws: true });
        const clusterRes = await handleCluster(
          request({ period_start: new Date(anchor - 1000).toISOString(), period_end: new Date(anchor + 1000).toISOString() }, INTERNAL_SECRET),
          { db, callEmbeddingImpl, callOpenAiImpl },
        );
        const clusterBody = await clusterRes.json();
        const failedCluster = clusterBody.clusters.find((c: { label_failed: boolean }) => c.label_failed);
        assert(failedCluster, "setup: the scripted label failure produced a label_failed cluster");
        const { data: dbCluster } = await db
          .from("clusters").select("id").eq("clustering_run_id", clusterBody.run_id).eq("label_failed", true).single();

        const { callOpenAiImpl: genImpl, calls } = scriptedGeneration();
        const res = await handleGenerate(
          request({ clustering_run_id: clusterBody.run_id, cluster_ids: [dbCluster!.id] }, INTERNAL_SECRET),
          { db, callOpenAiImpl: genImpl },
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ok, false, "a request containing only a label_failed cluster must not report success");
        assertEquals(calls.length, 0, "no LLM call was made for a label_failed cluster");

        const { data: reqRow } = await db.from("cluster_generation_requests").select("status").eq("id", body.generation_request_id).single();
        assertEquals(reqRow!.status, "failed");
        const { data: errRow } = await db
          .from("cluster_generation_request_errors").select("error_type").eq("generation_request_id", body.generation_request_id).single();
        assertEquals(errRow!.error_type, "label_failed");
      });

      // =====================================================================
      // STEP 4 + 5 — SUCCESSFUL SCRIPTED GENERATION + EXACT TRACEABILITY
      // =====================================================================
      await runStep("a successful scripted generation writes an immutable request/result with exact traceability", async () => {
        const anchor = Date.now() - 5 * 60_000;
        const text1 = `${runTag} success alpha.`;
        const text2 = `${runTag} success beta.`;
        const p1 = await makeAnonymisedPost(text1, 80, new Date(anchor).toISOString());
        const p2 = await makeAnonymisedPost(text2, 80, new Date(anchor).toISOString());
        const { runId, clusterId } = await makeCompletedRun(
          [{ ...p1, text: text1 }, { ...p2, text: text2 }],
          new Date(anchor - 1000).toISOString(), new Date(anchor + 1000).toISOString(),
        );

        const { callOpenAiImpl, calls } = scriptedGeneration();
        const res = await handleGenerate(
          request({ clustering_run_id: runId, cluster_ids: [clusterId] }, INTERNAL_SECRET),
          { db, callOpenAiImpl },
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ok, true);
        assert(body.generation_request_id);
        assertEquals(body.results.length, 1);
        assertEquals(body.results[0].cluster_id, clusterId);
        assert(body.results[0].post);
        assert(body.results[0].carousel);
        assertEquals(body.results[0].carousel.slides.length, 5);
        assertEquals(calls.length, 1, "exactly one LLM call for one selected cluster");

        // The request row is immutable/append-only in effect: status transitioned
        // exactly once, to completed.
        const { data: reqRow } = await db
          .from("cluster_generation_requests").select("status, clustering_run_id, requested_cluster_ids").eq("id", body.generation_request_id).single();
        assertEquals(reqRow!.status, "completed");
        assertEquals(reqRow!.clustering_run_id, runId);
        assertEquals(reqRow!.requested_cluster_ids, [clusterId]);

        // Exact traceability snapshot: raw_post_ids + anonymize_result_ids match
        // precisely what this cluster's posts resolved to, not just "some posts".
        const { data: resultRow } = await db
          .from("cluster_generation_results")
          .select("id, raw_post_ids, anonymize_result_ids, cluster_label, model, prompt_version, prompt_hash, config_snapshot")
          .eq("generation_request_id", body.generation_request_id).eq("cluster_id", clusterId).single();
        assert(resultRow);
        assertEquals(new Set(resultRow!.raw_post_ids), new Set([p1.rawPostId, p2.rawPostId]));
        assertEquals(new Set(resultRow!.anonymize_result_ids), new Set([p1.resultId, p2.resultId]));
        assertEquals(resultRow!.cluster_label, "Test Editorial Theme");
        assert(resultRow!.model);
        assert(resultRow!.prompt_version);
        assert(resultRow!.prompt_hash);
        assert(resultRow!.config_snapshot);

        // Append-only: a direct UPDATE must be rejected by the trigger.
        const { error: updateErr } = await db
          .from("cluster_generation_results").update({ cluster_label: "tampered" }).eq("id", resultRow!.id);
        assert(updateErr, "cluster_generation_results must reject direct UPDATE (append-only trigger)");
      });

      // =====================================================================
      // STEP 6 — LLM FAILURE PRODUCES A FAILED REQUEST, NO FAKE RESULT
      // =====================================================================
      await runStep("an LLM failure produces a failed request and no fake successful result", async () => {
        const anchor = Date.now() - 6 * 60_000;
        const text1 = `${runTag} llmfail alpha.`;
        const text2 = `${runTag} llmfail beta.`;
        const p1 = await makeAnonymisedPost(text1, 80, new Date(anchor).toISOString());
        const p2 = await makeAnonymisedPost(text2, 80, new Date(anchor).toISOString());
        const { runId, clusterId } = await makeCompletedRun(
          [{ ...p1, text: text1 }, { ...p2, text: text2 }],
          new Date(anchor - 1000).toISOString(), new Date(anchor + 1000).toISOString(),
        );

        const { callOpenAiImpl } = scriptedGeneration({ throws: true });
        const res = await handleGenerate(
          request({ clustering_run_id: runId, cluster_ids: [clusterId] }, INTERNAL_SECRET),
          { db, callOpenAiImpl },
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ok, false, "an LLM failure must not report success");
        assertEquals(body.results.length, 0, "no fake successful result is ever returned");

        const { data: reqRow } = await db.from("cluster_generation_requests").select("status, error_message").eq("id", body.generation_request_id).single();
        assertEquals(reqRow!.status, "failed");
        assert(reqRow!.error_message);

        const { count: resultCount } = await db
          .from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("generation_request_id", body.generation_request_id);
        assertEquals(resultCount, 0, "no generation_results row was written for the failed cluster");

        const { data: errRow } = await db
          .from("cluster_generation_request_errors").select("error_type").eq("generation_request_id", body.generation_request_id).single();
        assert(errRow!.error_type.startsWith("llm_"));
      });
    } finally {
      await t.step("zzz teardown", teardown);
    }
  },
});

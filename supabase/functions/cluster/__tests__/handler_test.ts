/**
 * Whole-flow tests for the cluster handler against the LOCAL Supabase stack.
 * OpenAI (embeddings + labeling) is always scripted; OPENAI_API_KEY is set to
 * a dummy value precisely so a real call would fail loudly rather than
 * quietly succeed.
 *
 * Sized to PHASE4_REQUIREMENTS.md §4's "small, focused" bar, extended per the
 * post-Checkpoint-8 correctness pass to cover: re-embedding on a changed
 * anonymize_result or embedding model, a historical run pointing at the exact
 * anonymize_result used, deterministic input ordering, total-embedding-
 * failure never producing a completed run, label failure never producing a
 * fake "Untitled cluster" success, and duplicate/out-of-input/multi-cluster
 * assignment rejection (schema-level; also covered directly in
 * scripts/verify_phase4.sql).
 *
 * Run (from the repo root):
 *   deno test --allow-env --allow-net supabase/functions/cluster/__tests__/
 *   (with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY=dummy /
 *   INGEST_INTERNAL_SECRET set, same as the other two Phase 4 suites)
 *
 * Skipped automatically when SUPABASE_URL is absent.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.19";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handleCluster } from "../index.ts";
import { scriptedEmbedding, scriptedLabel, tileVector } from "./fixtures.ts";

const URL_ = Deno.env.get("SUPABASE_URL");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const LIVE = Boolean(URL_ && SERVICE);
const INTERNAL_SECRET = Deno.env.get("INGEST_INTERNAL_SECRET") ?? "";

const db: SupabaseClient = LIVE
  ? createClient(URL_!, SERVICE!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

const runTag = `T-cluster-${Date.now()}-${crypto.randomUUID()}`;
let sourceId = "";
const rawPostIds: string[] = [];
let hadDefaultConfig = false;
const PERIOD_START = new Date(Date.now() - 30 * 86400_000).toISOString();
const PERIOD_END = new Date(Date.now() + 1 * 86400_000).toISOString();

function request(body: unknown, apikey?: string): Request {
  return new Request("https://local.test/cluster", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apikey ? { apikey } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/** Score a raw_post via the real scoring RPC chain (create/activate request,
 *  enqueue, claim, complete, promote via set_current_scoring_result) — a
 *  precondition backfill_anonymize_jobs actually checks (analyzed_posts.
 *  current_result_id must be non-null). Mirrors anonymize-worker's own test
 *  fixture, since service_role has no direct INSERT on scoring_results
 *  either — everything must go through the real RPCs, not a table insert. */
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

/** Score + anonymise a post via the real RPC chains end to end (backfill ->
 *  claim -> complete_anonymize_job), same as anonymize-worker's own suite —
 *  service_role has no direct INSERT on anonymize_results either. Returns
 *  both the raw_post_id and the exact anonymize_results.id produced, since
 *  tests need to distinguish "the post" from "the exact result used". */
async function makeAnonymisedPost(
  text: string,
  overallRelevance = 80,
  publishedAt?: string,
): Promise<{ rawPostId: string; resultId: string }> {
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

// There is no dedicated "re-anonymise" RPC in this schema (no product
// surface for it in Phase 4 yet), and backfill_anonymize_jobs only enqueues
// posts with NO current result, so an already-anonymised post cannot be
// re-anonymised through any RPC this test client can reach — pgmq itself is
// not exposed to PostgREST (config.toml: schemas = ["public",
// "graphql_public"]), so there is no way to send a fresh queue message from
// here either. The reproducibility guarantee this would exercise — a
// historical run's clustering_run_posts.anonymize_result_id staying pinned
// to the ORIGINAL result even after a later re-anonymisation — is instead
// proven at the database level in scripts/verify_phase4.sql §F2, which runs
// as the Postgres superuser and can legitimately simulate a second
// anonymize_results row directly (it is testing the schema's own guarantee,
// not exercising worker business logic). This suite instead proves the
// (anonymize_result_id, model) keying itself: two distinct posts (thus two
// distinct anonymize_result_ids) never collide in post_embeddings, and a
// post's embedding is looked up by its actual current_result_id, not a bare
// raw_post_id — see "an embedding is looked up by anonymize_result_id, not
// raw_post_id" below.

async function requireSchema() {
  for (const table of ["post_embeddings", "clustering_runs", "clustering_run_posts", "clusters", "cluster_assignments"]) {
    const { error } = await db.from(table).select("*", { head: true, count: "exact" });
    if (error) throw new Error(`required table public.${table} is missing or unreachable: ${error.message}`);
  }
  const { error: rpcErr } = await db.rpc("create_clustering_run", {
    p_period_start: PERIOD_START, p_period_end: PERIOD_START,
    p_min_relevance_score: 0, p_cluster_similarity_threshold: 0.5, p_min_cluster_size: 1,
    p_embedding_model: "schema-check",
  });
  if (rpcErr) throw new Error(`required RPC public.create_clustering_run is missing or broken: ${rpcErr.message}`);
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
    // Pin the two clustering knobs to known values for this suite's assertions,
    // regardless of whatever a prior/real config row happens to have.
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
// Postgres "permission denied" — 0015 grants service_role SELECT only on
// cluster_assignments/clustering_run_posts/post_embeddings (mutation goes
// through the RPCs), so a direct DELETE always fails this way. Expected,
// not a teardown bug — reported below, not silently discarded.
const PERMISSION_DENIED = "42501";

async function teardown() {
  const failures: string[] = [];
  const retained: string[] = [];

  if (rawPostIds.length) {
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

    // raw_posts is FK-restricted by clustering_run_posts/cluster_assignments/
    // anonymize_results (raw_post_id references raw_posts on delete restrict)
    // whenever this run's posts landed in a real cluster or were anonymised —
    // expected, not a failure.
    const { error: rpErr } = await db.from("raw_posts").delete().in("id", rawPostIds);
    if (rpErr && rpErr.code !== FK_RESTRICT_VIOLATION) failures.push(`raw_posts cleanup: ${rpErr.message}`);
    else if (rpErr) retained.push(`raw_posts: retained (FK-restrict from clustering_run_posts/cluster_assignments/anonymize_results)`);
  }

  if (retained.length) {
    console.warn(`[cluster teardown] retained-row report for run tag ${runTag}:\n  - ${retained.join("\n  - ")}`);
  }

  // clusters/clustering_runs/anonymize_results left in place — no DELETE
  // grant to service_role (mirrors 0005/0014's pattern); they're immutable
  // audit records anyway.

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
  name: "[cluster] whole flow",
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
      // AUTHORISATION / REQUEST VALIDATION
      // =====================================================================
      await runStep("no credentials -> 401", async () => {
        const res = await handleCluster(request({ period_start: PERIOD_START, period_end: PERIOD_END }), { db });
        assertEquals(res.status, 401);
      });

      await runStep("period_end before period_start -> 400", async () => {
        const res = await handleCluster(
          request({ period_start: PERIOD_END, period_end: PERIOD_START }, INTERNAL_SECRET), { db },
        );
        assertEquals(res.status, 400);
      });

      await runStep("missing period fields -> 400", async () => {
        const res = await handleCluster(request({}, INTERNAL_SECRET), { db });
        assertEquals(res.status, 400);
      });

      // =====================================================================
      // EMPTY WINDOW — zero eligible posts is a clean result, not an error
      // =====================================================================
      await runStep("a window with zero eligible posts returns a clean empty result", async () => {
        const farPast = new Date(Date.UTC(2000, 0, 1)).toISOString();
        const farPastEnd = new Date(Date.UTC(2000, 0, 2)).toISOString();
        const { callEmbeddingImpl, calls } = scriptedEmbedding({});
        const res = await handleCluster(
          request({ period_start: farPast, period_end: farPastEnd }, INTERNAL_SECRET),
          { db, callEmbeddingImpl },
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ok, true);
        assertEquals(body.run_id, null);
        assertEquals(body.totals.eligible, 0);
        assertEquals(body.clusters.length, 0);
        assertEquals(calls.length, 0, "no embedding calls for an empty window");
      });

      // =====================================================================
      // TOTAL EMBEDDING FAILURE — must never report a completed run
      // =====================================================================
      await runStep(
        "all embeddings failing produces a failed run, not a completed one with zero clusters",
        async () => {
          const post = await makeAnonymisedPost(`${runTag} embedding-failure post.`);
          const { callEmbeddingImpl } = scriptedEmbedding({}, { throws: "server_error" });
          const { callOpenAiImpl } = scriptedLabel();

          const res = await handleCluster(
            request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
            { db, callEmbeddingImpl, callOpenAiImpl },
          );
          assertEquals(res.status, 200);
          const body = await res.json();
          assertEquals(body.ok, false, "the response itself must not claim success");
          assert(body.run_id, "a run row exists (the attempt is on record)");
          assertEquals(body.totals.embedded, 0);

          const { data: run } = await db.from("clustering_runs").select("status, error_message").eq("id", body.run_id).single();
          assertEquals(run!.status, "failed", "the run row itself must never say completed here");
          assert(run!.error_message, "a human-readable reason is stored");

          const { count: clusterCount } = await db
            .from("clusters").select("*", { count: "exact", head: true }).eq("clustering_run_id", body.run_id);
          assertEquals(clusterCount, 0, "no clusters were persisted for a failed run");

          // Sanity: the post's own eligibility isn't touched by this failure.
          const { data: apc } = await db.from("anonymized_posts_current").select("raw_post_id").eq("raw_post_id", post.rawPostId).single();
          assert(apc);
        },
      );

      // =====================================================================
      // TOO-SMALL DATASET — below min_cluster_size never force-merges
      // =====================================================================
      await runStep("a single eligible post stays unclustered, not force-merged", async () => {
        // A fixed, explicit published_at OFFSET WELL AWAY from "now" (10
        // minutes in the past), with a window built from that same anchor:
        // every other fixture in this suite defaults publishedAt to
        // `new Date().toISOString()` at whatever moment its own step ran,
        // so two adjacent steps' posts can land within the same second of
        // wall-clock time — a window merely narrowed around "now" is not
        // reliably tight enough to exclude a sibling post created a few
        // hundred ms earlier by the step just above. Anchoring 10 minutes
        // back removes the race structurally instead of by shrinking it.
        const anchor = Date.now() - 10 * 60_000;
        const publishedAt = new Date(anchor).toISOString();
        const windowStart = new Date(anchor - 1000).toISOString();
        const windowEnd = new Date(anchor + 1000).toISOString();
        await makeAnonymisedPost(`${runTag} lone post.`, 80, publishedAt);
        const { callEmbeddingImpl } = scriptedEmbedding({}, { vector: tileVector([1, 0, 0]) });
        const { callOpenAiImpl } = scriptedLabel();
        const res = await handleCluster(
          request({ period_start: windowStart, period_end: windowEnd }, INTERNAL_SECRET),
          { db, callEmbeddingImpl, callOpenAiImpl },
        );
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.ok, true);
        assertEquals(body.totals.eligible, 1, "this window contains exactly the one post just created");
        assertEquals(body.totals.clusters, 0, "min_cluster_size=2 means a lone post forms no cluster");
        assertEquals(body.totals.unclustered, 1);
      });

      // =====================================================================
      // LABEL FAILURE — must never present a fake successful title
      // =====================================================================
      await runStep(
        "a cluster-label LLM failure marks label_failed, never a fake title",
        async () => {
          const p1 = await makeAnonymisedPost(`${runTag} label-fail post alpha.`);
          const p2 = await makeAnonymisedPost(`${runTag} label-fail post beta.`);
          const vec = tileVector([5, 5, 5]);
          const { callEmbeddingImpl } = scriptedEmbedding({
            [`${runTag} label-fail post alpha.`]: { vector: vec },
            [`${runTag} label-fail post beta.`]: { vector: vec },
          });
          const { callOpenAiImpl } = scriptedLabel({ throws: true });

          const res = await handleCluster(
            request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
            { db, callEmbeddingImpl, callOpenAiImpl },
          );
          const body = await res.json();
          assertEquals(body.ok, true, "labeling failure does not fail the whole run — the clustering itself is still real");

          const labelFailedCluster = body.clusters.find((c: { label_failed: boolean }) => c.label_failed === true);
          assert(labelFailedCluster, "at least one cluster reports label_failed=true");
          assertNotEquals(labelFailedCluster.label, "Untitled cluster", "no fabricated success-looking title");

          const { data: dbCluster } = await db
            .from("clusters").select("label, label_failed").eq("clustering_run_id", body.run_id).eq("label_failed", true).maybeSingle();
          assert(dbCluster, "label_failed is persisted, not just reported in the HTTP response");
          assertEquals(dbCluster!.label_failed, true);

          // The cluster's assignments are still real despite the label failure.
          const { count: assignCount } = await db
            .from("cluster_assignments").select("*", { count: "exact", head: true })
            .in("raw_post_id", [p1.rawPostId, p2.rawPostId]).eq("clustering_run_id", body.run_id);
          assertEquals(assignCount, 2, "both posts are still genuinely assigned despite the label failure");
        },
      );

      // =====================================================================
      // INPUT/OUTPUT SCHEMA + COHERENCE GUARD — two distinct clusters form,
      // not one meaningless fallback bucket.
      // =====================================================================
      await runStep(
        "two similar posts and two other similar posts form two distinct clusters",
        async () => {
          const a1 = await makeAnonymisedPost(`${runTag} innovation post alpha.`);
          const a2 = await makeAnonymisedPost(`${runTag} innovation post beta.`);
          const b1 = await makeAnonymisedPost(`${runTag} heritage post alpha.`);
          const b2 = await makeAnonymisedPost(`${runTag} heritage post beta.`);

          const vecA = tileVector([1, 0, 0]);
          const vecB = tileVector([0, 1, 0]);
          const { callEmbeddingImpl } = scriptedEmbedding({
            [`${runTag} innovation post alpha.`]: { vector: vecA },
            [`${runTag} innovation post beta.`]: { vector: vecA },
            [`${runTag} heritage post alpha.`]: { vector: vecB },
            [`${runTag} heritage post beta.`]: { vector: vecB },
          });
          const { callOpenAiImpl } = scriptedLabel();

          const res = await handleCluster(
            request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
            { db, callEmbeddingImpl, callOpenAiImpl },
          );
          assertEquals(res.status, 200);
          const body = await res.json();

          // eligible includes this test's 4 posts plus whatever is still
          // lingering from earlier steps (same period, same run tag scope) —
          // assert on structure/shape, not an exact total.
          assert(body.run_id, "a run_id is returned for a non-empty run");
          assert(Array.isArray(body.clusters));
          assert(body.clusters.length >= 2, "at least the two distinct clusters formed, not one fallback bucket");
          for (const c of body.clusters) {
            assert(typeof c.label === "string" && c.label.length > 0);
            assert(typeof c.post_count === "number" && c.post_count >= 2);
          }

          // Reproducibility: the run record captures the snapshotted config
          // values used.
          const { data: run } = await db.from("clustering_runs").select("*").eq("id", body.run_id).single();
          assertEquals(run!.status, "completed");
          assertEquals(Number(run!.cluster_similarity_threshold), 0.9);
          assertEquals(run!.min_cluster_size, 2);
          assertEquals(run!.embedding_model, "text-embedding-3-small");

          // Reproducibility: the run's input-set record captures the EXACT
          // anonymize_result_id used for each post, not just the post id —
          // this is what makes the run reconstructable even after a later
          // re-anonymisation of the same posts.
          const { data: runPosts } = await db
            .from("clustering_run_posts").select("raw_post_id, anonymize_result_id").eq("clustering_run_id", body.run_id);
          const runPostMap = new Map((runPosts ?? []).map((r) => [r.raw_post_id, r.anonymize_result_id]));
          for (const p of [a1, a2, b1, b2]) {
            assertEquals(runPostMap.get(p.rawPostId), p.resultId, `run records the exact anonymize_result_id used for ${p.rawPostId}`);
          }
        },
      );

      // =====================================================================
      // HISTORICAL RECONSTRUCTION — a run's input-set record points at the
      // exact anonymize_result_id used, not just the raw_post_id. Full
      // proof that this survives a LATER re-anonymisation lives in
      // scripts/verify_phase4.sql §F2 (which can legitimately simulate a
      // second anonymize_results row at the database level); see the
      // requireSchema-adjacent comment above makeAnonymisedPost for why this
      // suite can't reach that path through real RPCs alone.
      // =====================================================================
      await runStep(
        "a run's input-set record points at the exact anonymize_result_id used for each post",
        async () => {
          const post = await makeAnonymisedPost(`${runTag} history post text.`);
          const { callEmbeddingImpl } = scriptedEmbedding({}, { vector: tileVector([9, 1, 1]) });
          const { callOpenAiImpl } = scriptedLabel();

          // Alone in its own tight window so it's unambiguously "the" input.
          const soloStart = new Date(Date.now() - 1000).toISOString();
          const soloEnd = new Date(Date.now() + 1000).toISOString();
          await handleCluster(request({ period_start: soloStart, period_end: soloEnd }, INTERNAL_SECRET), {
            db, callEmbeddingImpl, callOpenAiImpl,
          });

          const { data: runPost } = await db
            .from("clustering_run_posts").select("anonymize_result_id")
            .eq("raw_post_id", post.rawPostId).order("clustering_run_id", { ascending: false }).limit(1).single();
          assertEquals(runPost!.anonymize_result_id, post.resultId, "the run's input-set record names the exact result used");
        },
      );

      // =====================================================================
      // RE-EMBEDDING — embeddings are keyed by (anonymize_result_id, model),
      // not raw_post_id: two DIFFERENT posts (thus two distinct
      // anonymize_result_ids) never collide, and reuse only happens for the
      // exact result actually looked up. The "a changed result forces a new
      // embedding" half of this is proven directly in
      // scripts/verify_phase4.sql §F2 (same reason as above).
      // =====================================================================
      await runStep("a post with an existing embedding for its current result+model is not re-embedded", async () => {
        const post = await makeAnonymisedPost(`${runTag} reuse-check post.`);
        const { callEmbeddingImpl: firstImpl } = scriptedEmbedding({}, { vector: tileVector([1, 1, 1]) });
        const { callOpenAiImpl } = scriptedLabel();
        await handleCluster(
          request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
          { db, callEmbeddingImpl: firstImpl, callOpenAiImpl },
        );

        const { data: embeddedRow } = await db
          .from("post_embeddings").select("anonymize_result_id").eq("anonymize_result_id", post.resultId).maybeSingle();
        assert(embeddedRow, "the post got an embedding written on the first run, keyed by anonymize_result_id");

        const { callEmbeddingImpl: secondImpl, calls } = scriptedEmbedding({});
        await handleCluster(
          request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
          { db, callEmbeddingImpl: secondImpl, callOpenAiImpl },
        );
        const calledForThisPost = calls.some((c) => c.input.includes("reuse-check"));
        assert(!calledForThisPost, "a post with an existing embedding for its current result+model is never re-embedded");
      });

      await runStep("two distinct posts never share an embedding, even with identical text", async () => {
        // Same text, but each makeAnonymisedPost call produces its OWN
        // anonymize_results row (a fresh idempotency_key each time) — proving
        // the embedding key is genuinely per-result, not content-addressed
        // or accidentally shared via raw_post_id collision.
        const text = `${runTag} identical text on two different posts.`;
        const postA = await makeAnonymisedPost(text);
        const postB = await makeAnonymisedPost(text);
        assertNotEquals(postA.resultId, postB.resultId, "two separate anonymisations produce two separate result ids");

        const { callEmbeddingImpl } = scriptedEmbedding({}, { vector: tileVector([4, 4, 4]) });
        const { callOpenAiImpl } = scriptedLabel();
        await handleCluster(
          request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
          { db, callEmbeddingImpl, callOpenAiImpl },
        );

        const { count } = await db
          .from("post_embeddings").select("*", { count: "exact", head: true })
          .in("anonymize_result_id", [postA.resultId, postB.resultId]);
        assertEquals(count, 2, "each result got its own embedding row despite identical source text");
      });

      // =====================================================================
      // DETERMINISTIC INPUT ORDERING — same input set clusters the same way
      // regardless of the order rows happen to come back in.
      // =====================================================================
      await runStep("clustering the same input set twice produces the same grouping", async () => {
        const p1 = await makeAnonymisedPost(`${runTag} order-check post one.`);
        const p2 = await makeAnonymisedPost(`${runTag} order-check post two.`);
        const p3 = await makeAnonymisedPost(`${runTag} order-check post three.`);
        const vec = tileVector([7, 7, 7]);
        const { callEmbeddingImpl } = scriptedEmbedding({
          [`${runTag} order-check post one.`]: { vector: vec },
          [`${runTag} order-check post two.`]: { vector: vec },
          [`${runTag} order-check post three.`]: { vector: vec },
        });
        const { callOpenAiImpl } = scriptedLabel();

        const soloStart = new Date(Date.now() - 2000).toISOString();
        const soloEnd = new Date(Date.now() + 2000).toISOString();

        const res1 = await handleCluster(request({ period_start: soloStart, period_end: soloEnd }, INTERNAL_SECRET), {
          db, callEmbeddingImpl, callOpenAiImpl,
        });
        const body1 = await res1.json();

        const { callEmbeddingImpl: embedImpl2 } = scriptedEmbedding({});
        const res2 = await handleCluster(request({ period_start: soloStart, period_end: soloEnd }, INTERNAL_SECRET), {
          db, callEmbeddingImpl: embedImpl2, callOpenAiImpl,
        });
        const body2 = await res2.json();

        assertEquals(body1.totals.clusters, body2.totals.clusters, "same input set, same number of clusters both times");
        for (const p of [p1, p2, p3]) {
          const { data: a1 } = await db.from("cluster_assignments").select("cluster_id").eq("clustering_run_id", body1.run_id).eq("raw_post_id", p.rawPostId).maybeSingle();
          const { data: a2 } = await db.from("cluster_assignments").select("cluster_id").eq("clustering_run_id", body2.run_id).eq("raw_post_id", p.rawPostId).maybeSingle();
          assertEquals(!!a1, !!a2, `post ${p.rawPostId} is clustered (or not) consistently across both runs`);
        }
      });

      // =====================================================================
      // MODEL ISOLATION — the post-Checkpoint-9 correctness pass. A post
      // embedded under two DIFFERENT models must only ever contribute its
      // matching-model embedding to a run's centroid / assignment, and
      // changing the configured model forces a fresh lookup rather than
      // reusing another model's row.
      // =====================================================================
      await runStep(
        "same anonymize_result embedded under two models: a run only uses its own model's embedding",
        async () => {
          const p1 = await makeAnonymisedPost(`${runTag} model-isolation post alpha.`);
          const p2 = await makeAnonymisedPost(`${runTag} model-isolation post beta.`);
          const modelAVec = tileVector([3, 3, 3]);
          const modelBVec = tileVector([-3, -3, -3]); // deliberately dissimilar under cosine similarity

          const prevModel = Deno.env.get("CLUSTER_EMBEDDING_MODEL");
          try {
            // First run under "model-a": embeds both posts with modelAVec.
            Deno.env.set("CLUSTER_EMBEDDING_MODEL", "model-a");
            const { callEmbeddingImpl: embedA } = scriptedEmbedding({
              [`${runTag} model-isolation post alpha.`]: { vector: modelAVec },
              [`${runTag} model-isolation post beta.`]: { vector: modelAVec },
            });
            const { callOpenAiImpl } = scriptedLabel();
            const resA = await handleCluster(
              request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
              { db, callEmbeddingImpl: embedA, callOpenAiImpl },
            );
            const bodyA = await resA.json();
            assertEquals(bodyA.ok, true);
            const { data: runA } = await db.from("clustering_runs").select("embedding_model").eq("id", bodyA.run_id).single();
            assertEquals(runA!.embedding_model, "model-a");

            // Now embed the SAME two posts (same anonymize_result_id) under a
            // completely different model, with dissimilar vectors — if the
            // centroid/grouping ever accidentally mixed models, this would
            // change the outcome; it must not.
            Deno.env.set("CLUSTER_EMBEDDING_MODEL", "model-b");
            const { callEmbeddingImpl: embedB } = scriptedEmbedding({
              [`${runTag} model-isolation post alpha.`]: { vector: modelBVec },
              [`${runTag} model-isolation post beta.`]: { vector: modelBVec },
            });
            const resB = await handleCluster(
              request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
              { db, callEmbeddingImpl: embedB, callOpenAiImpl },
            );
            const bodyB = await resB.json();
            assertEquals(bodyB.ok, true);
            const { data: runB } = await db.from("clustering_runs").select("embedding_model").eq("id", bodyB.run_id).single();
            assertEquals(runB!.embedding_model, "model-b");

            // Both post_embeddings rows exist independently, one per model.
            const { count: embedCount } = await db
              .from("post_embeddings").select("*", { count: "exact", head: true })
              .in("anonymize_result_id", [p1.resultId, p2.resultId]);
            assertEquals(embedCount, 4, "2 posts x 2 models = 4 independent embedding rows, none overwritten");

            // Run B's cluster centroid must be computed from model-b's
            // vectors only — verified indirectly: both posts are still
            // assigned together (they're identical under model-b too), and
            // the run row's own embedding_model confirms which model was
            // actually used, per complete_clustering_run's model-scoped join.
            const { data: clusterB } = await db.from("clusters").select("id, post_count").eq("clustering_run_id", bodyB.run_id).maybeSingle();
            if (clusterB) assertEquals(clusterB.post_count, 2);
          } finally {
            if (prevModel === undefined) Deno.env.delete("CLUSTER_EMBEDDING_MODEL");
            else Deno.env.set("CLUSTER_EMBEDDING_MODEL", prevModel);
          }
        },
      );

      await runStep(
        "changing CLUSTER_EMBEDDING_MODEL causes a new embedding call rather than reusing another model's row",
        async () => {
          // A tight, anchored-in-the-past window (mirrors the "lone post"
          // test above): the shared PERIOD_START/PERIOD_END range also
          // contains every post created by earlier steps in this suite, so
          // asserting an exact calls.length against that wide window would
          // pick up all of them, not just this test's own fixture.
          const anchor = Date.now() - 20 * 60_000;
          const publishedAt = new Date(anchor).toISOString();
          const windowStart = new Date(anchor - 1000).toISOString();
          const windowEnd = new Date(anchor + 1000).toISOString();

          const post = await makeAnonymisedPost(`${runTag} model-change post.`, 80, publishedAt);
          const prevModel = Deno.env.get("CLUSTER_EMBEDDING_MODEL");
          try {
            Deno.env.set("CLUSTER_EMBEDDING_MODEL", "model-x");
            const { callEmbeddingImpl: embedX } = scriptedEmbedding({}, { vector: tileVector([6, 6, 6]) });
            const { callOpenAiImpl } = scriptedLabel();
            await handleCluster(
              request({ period_start: windowStart, period_end: windowEnd }, INTERNAL_SECRET),
              { db, callEmbeddingImpl: embedX, callOpenAiImpl },
            );
            const { data: rowX } = await db
              .from("post_embeddings").select("model").eq("anonymize_result_id", post.resultId).eq("model", "model-x").maybeSingle();
            assert(rowX, "embedded under model-x");

            Deno.env.set("CLUSTER_EMBEDDING_MODEL", "model-y");
            const { callEmbeddingImpl: embedY, calls } = scriptedEmbedding({}, { vector: tileVector([6, 6, 6]) });
            await handleCluster(
              request({ period_start: windowStart, period_end: windowEnd }, INTERNAL_SECRET),
              { db, callEmbeddingImpl: embedY, callOpenAiImpl },
            );
            assertEquals(calls.length, 1, "switching models triggers a fresh embedding call, not a reuse of model-x's row");
            const { data: rowY } = await db
              .from("post_embeddings").select("model").eq("anonymize_result_id", post.resultId).eq("model", "model-y").maybeSingle();
            assert(rowY, "a new row was written under model-y — the old model-x row was never touched, just not looked up");
          } finally {
            if (prevModel === undefined) Deno.env.delete("CLUSTER_EMBEDDING_MODEL");
            else Deno.env.set("CLUSTER_EMBEDDING_MODEL", prevModel);
          }
        },
      );

      // =====================================================================
      // SCHEMA-LEVEL PAIRING — mismatched raw_post_id/anonymize_result_id is
      // rejected by the database itself (composite FK), not just app code.
      // =====================================================================
      await runStep("a mismatched raw_post_id/anonymize_result_id pair is rejected by the database", async () => {
        const p1 = await makeAnonymisedPost(`${runTag} pairing-check post one.`);
        const p2 = await makeAnonymisedPost(`${runTag} pairing-check post two.`);

        // upsert_post_embedding is the real path an Edge Function uses (no
        // direct table INSERT grant on post_embeddings) — passing p1's
        // anonymize_result_id paired with p2's raw_post_id must be rejected
        // by the composite FK inside the RPC, not merely by the RPC's own
        // application logic (which does no such cross-check itself; it's
        // the database's own constraint here that has to catch this).
        const { error } = await db.rpc("upsert_post_embedding", {
          p_anonymize_result_id: p1.resultId, // belongs to p1...
          p_raw_post_id: p2.rawPostId, // ...but paired here with p2's post id
          p_embedding: JSON.stringify(tileVector([1, 1, 1])),
          p_model: "mismatch-test",
        });
        assert(error, "a mismatched (anonymize_result_id, raw_post_id) pair must raise");
        assert(
          /foreign key|violates/i.test(error!.message),
          `expected a foreign-key-violation style error, got: ${error!.message}`,
        );
      });

      // =====================================================================
      // DUPLICATE/CONFLICTING RUN INPUT — rejected, not silently ignored.
      // =====================================================================
      await runStep("a duplicate clustering-run input is rejected, not silently ignored", async () => {
        const post = await makeAnonymisedPost(`${runTag} duplicate-input post.`);
        const runId = await (async () => {
          const { data, error } = await db.rpc("create_clustering_run", {
            p_period_start: PERIOD_START, p_period_end: PERIOD_END,
            p_min_relevance_score: 50, p_cluster_similarity_threshold: 0.9, p_min_cluster_size: 2,
            p_embedding_model: "dup-test-model",
          });
          if (error) throw error;
          return data as string;
        })();

        const { error: firstErr } = await db.rpc("record_clustering_run_input", {
          p_run_id: runId,
          p_input: [{ raw_post_id: post.rawPostId, anonymize_result_id: post.resultId }],
        });
        assertEquals(firstErr, null, "the first, legitimate call succeeds");

        const { error: secondErr } = await db.rpc("record_clustering_run_input", {
          p_run_id: runId,
          p_input: [{ raw_post_id: post.rawPostId, anonymize_result_id: post.resultId }],
        });
        assert(secondErr, "a second call recording input for a run that already has input must raise, not silently no-op");

        const { count } = await db.from("clustering_run_posts").select("*", { count: "exact", head: true }).eq("clustering_run_id", runId);
        assertEquals(count, 1, "still exactly one input row — the rejected second call wrote nothing");
      });

      // =====================================================================
      // PARTIAL EMBEDDING FAILURE — persisted and queryable after the HTTP
      // response is gone.
      // =====================================================================
      await runStep("a partial embedding failure is persisted on clustering_run_posts and stays queryable", async () => {
        const failing = await makeAnonymisedPost(`${runTag} partial-fail post that fails.`);
        const succeeding = await makeAnonymisedPost(`${runTag} partial-fail post that succeeds.`);

        let call = 0;
        const callEmbeddingImpl = (async (opts: { input: string }) => {
          call++;
          if (opts.input.includes("that fails")) {
            const { EmbeddingError } = await import("../../_shared/embeddings.ts");
            throw new EmbeddingError("server_error", "scripted partial embedding failure");
          }
          return tileVector([8, 8, 8]);
        }) as never;
        const { callOpenAiImpl } = scriptedLabel();

        const res = await handleCluster(
          request({ period_start: PERIOD_START, period_end: PERIOD_END }, INTERNAL_SECRET),
          { db, callEmbeddingImpl, callOpenAiImpl },
        );
        const body = await res.json();
        assert(body.run_id, "the run still completes (enough posts succeeded to proceed) with a partial failure recorded");

        // Long after the HTTP response, the per-post outcome is still there.
        const { data: failedRow } = await db
          .from("clustering_run_posts").select("embedding_status, embedding_error_message")
          .eq("clustering_run_id", body.run_id).eq("raw_post_id", failing.rawPostId).single();
        assertEquals(failedRow!.embedding_status, "failed");
        assert(failedRow!.embedding_error_message?.includes("scripted partial embedding failure"));

        const { data: okRow } = await db
          .from("clustering_run_posts").select("embedding_status")
          .eq("clustering_run_id", body.run_id).eq("raw_post_id", succeeding.rawPostId).single();
        assertEquals(okRow!.embedding_status, "embedded");
      });

      // =====================================================================
      // A FAILED INPUT CANNOT BE ASSIGNED TO A CLUSTER
      // =====================================================================
      await runStep("a failed input cannot be assigned to a cluster (RPC-level rejection)", async () => {
        const post = await makeAnonymisedPost(`${runTag} cannot-assign-failed post.`);
        const { data: runId, error: runErr } = await db.rpc("create_clustering_run", {
          p_period_start: PERIOD_START, p_period_end: PERIOD_END,
          p_min_relevance_score: 50, p_cluster_similarity_threshold: 0.9, p_min_cluster_size: 1,
          p_embedding_model: "assign-fail-test",
        });
        if (runErr) throw runErr;
        await db.rpc("record_clustering_run_input", {
          p_run_id: runId, p_input: [{ raw_post_id: post.rawPostId, anonymize_result_id: post.resultId }],
        });
        await db.rpc("record_embedding_outcome", {
          p_run_id: runId, p_raw_post_id: post.rawPostId, p_status: "failed", p_error_message: "test failure",
        });

        const { error: completeErr } = await db.rpc("complete_clustering_run", {
          p_run_id: runId,
          p_clusters: [{ label: "Should Not Work", label_failed: false, post_ids: [post.rawPostId] }],
        });
        assert(completeErr, "assigning a post whose embedding_status is 'failed' to a cluster must be rejected");

        const { count } = await db.from("cluster_assignments").select("*", { count: "exact", head: true }).eq("clustering_run_id", runId);
        assertEquals(count, 0, "no assignment was written for the rejected attempt");
      });
    } finally {
      await t.step("zzz teardown", teardown);
    }
  },
});

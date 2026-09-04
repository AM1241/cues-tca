/**
 * Whole-flow tests for the purge_source RPC (0026, fixed for scored/anonymised
 * sources by 0028) against the LOCAL Supabase stack.
 *
 * purge_source has no Edge Function handler — the frontend calls it directly
 * via PostgREST RPC — so this suite does the same, through per-role
 * AUTHENTICATED clients (anon key + a real signed-in session), exactly like an
 * editor's browser would. is_admin()/is_editor() read auth.uid(), which only
 * resolves for a real signed-in JWT, not for the service-role key — the
 * service-role client (fixtures.db) is used only to build fixtures the
 * frontend itself could never construct directly.
 *
 * Written after finding, and fixing (0028), a real bug while building this
 * suite: purge_source deletes from scoring_results/anonymize_results, but
 * neither table's append-only trigger had ever had an exception, for anyone —
 * so purge_source raised and aborted on ANY source that had been scored or
 * anonymised even once, which is nearly every real source. The "clean purge"
 * step below is a direct regression test for that fix; it fails against 0026
 * alone and passes only with 0028 applied.
 *
 * Run (from the repo root):
 *   docker run --rm --network supabase_network_cues-editorial-cloud \
 *     -v "$PWD/supabase/functions:/app" -w /app \
 *     -e SUPABASE_URL=http://kong:8000 -e SUPABASE_ANON_KEY=... \
 *     -e SUPABASE_SERVICE_ROLE_KEY=... \
 *     denoland/deno:alpine-2.5.2 deno test --allow-env --allow-net _admin_rpcs/__tests__/purge_source_test.ts
 *
 * Skipped automatically when SUPABASE_URL/ANON/SERVICE_ROLE are absent.
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import {
  LIVE, db, actingAs, makeUser, makeSource, makeRawPost, makeScoringRequest,
  scoreAndPromote, scoreAndDeadLetter, anonymizeAndComplete, anonymizeAndDeadLetter,
  embedIntoNewRun, completeIntoOneCluster, buildClusteredPost,
} from "./fixtures.ts";

const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const emails = {
  admin: `purge-admin.${stamp}@cues.test`,
  editor: `purge-editor.${stamp}@cues.test`,
  outsider: `purge-outsider.${stamp}@cues.test`,
};
const tokens: Record<string, string> = {};
const userIds: string[] = [];
let adminClient: SupabaseClient;
let editorClient: SupabaseClient;
let outsiderClient: SupabaseClient;

const sourceIds: string[] = []; // every source this suite creates, for teardown
const ingestRunIds: string[] = [];

async function trackedSource(name: string): Promise<string> {
  const id = await makeSource(name);
  sourceIds.push(id);
  return id;
}

/** Builds a real cluster_generation_results row citing rawPostId, optionally approved. */
async function makeBlockingResult(
  rawPostId: string, clusteringRunId: string, clusterId: string, label: string, approve: boolean,
): Promise<string> {
  const { data: reqId, error } = await db.rpc("create_cluster_generation_request", {
    p_clustering_run_id: clusteringRunId, p_requested_cluster_ids: [clusterId], p_output_types: ["post"],
  });
  if (error) throw error;
  const { data: resultId, error: e2 } = await db.rpc("complete_cluster_generation_result", {
    p_request_id: reqId, p_cluster_id: clusterId, p_cluster_label: label,
    p_raw_post_ids: [rawPostId], p_anonymize_result_ids: [crypto.randomUUID()],
    p_output_types: ["post"], p_post_output: { text: "generated test copy" }, p_carousel_output: null,
    p_config_snapshot: {}, p_prompt_version: "v1", p_prompt_hash: "h", p_model: "gpt-test",
  });
  if (e2) throw e2;
  const { error: e3 } = await db.rpc("finish_cluster_generation_request", { p_request_id: reqId });
  if (e3) throw e3;
  if (approve) {
    const { error: e4 } = await db.from("cluster_generation_reviews")
      .update({ status: "approved" }).eq("result_id", resultId).eq("output_type", "post");
    if (e4) throw e4;
  }
  return resultId as string;
}

async function makeIngestRunSource(sourceId: string): Promise<void> {
  // started_at defaults to now() at insert time; backdating it here avoids a
  // race against the client-computed finished_at tripping
  // ingest_runs_finish_after_start (finished_at must be >= started_at).
  const { data: run, error } = await db.from("ingest_runs")
    .insert({
      trigger_source: "manual", status: "completed",
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
    })
    .select("id").single();
  if (error) throw error;
  ingestRunIds.push(run!.id as string);
  const { error: e2 } = await db.from("ingest_run_sources")
    .insert({
      run_id: run!.id, source_id: sourceId, source_name: "fixture", status: "ok",
      started_at: new Date(Date.now() - 5000).toISOString(),
      finished_at: new Date().toISOString(),
    });
  if (e2) throw e2;
}

async function setup() {
  await makeUser(emails.admin, "admin", tokens, userIds);
  await makeUser(emails.editor, "editor", tokens, userIds);
  await makeUser(emails.outsider, null, tokens, userIds);
  adminClient = actingAs(tokens[emails.admin]);
  editorClient = actingAs(tokens[emails.editor]);
  outsiderClient = actingAs(tokens[emails.outsider]);
}

async function teardown() {
  const failures: string[] = [];
  const retained: string[] = [];

  for (const id of ingestRunIds) {
    const { error } = await db.from("ingest_runs").delete().eq("id", id);
    if (error) retained.push(`ingest_runs ${id}: ${error.message}`);
  }

  // Sources already purged by the test itself delete as a 0-row no-op here.
  // Sources still carrying scored/anonymised/cited history cannot be removed
  // by this teardown at all — scoring_results/anonymize_results/
  // cluster_generation_results grant service_role SELECT only (writes are
  // RPC-only by design) and raw_posts FK-restricts against them, so the
  // delete below fails with 23503 for exactly those rows. Expected and
  // reported, same discipline as score-worker/ingest's own test teardown.
  for (const id of sourceIds) {
    const { error } = await db.from("sources").delete().eq("id", id);
    if (error && error.code !== "23503") failures.push(`sources ${id}: ${error.message}`);
    else if (error) retained.push(`sources ${id}: retained (FK-restricted by real pipeline history, by design)`);
  }

  for (const id of userIds) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) failures.push(`auth user ${id}: ${error.message}`);
  }

  if (retained.length) console.warn(`[purge_source teardown] retained:\n  - ${retained.join("\n  - ")}`);
  if (failures.length) throw new Error(`teardown hit unexpected errors:\n  - ${failures.join("\n  - ")}`);
}

Deno.test({
  name: "[purge_source] whole flow",
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
      // AUTHORISATION
      // =====================================================================
      await runStep("a non-admin editor cannot purge a source", async () => {
        const sourceId = await trackedSource(`T-authgate-editor-${stamp}`);
        const { error } = await editorClient.rpc("purge_source", { p_source_id: sourceId });
        assert(error, "an editor without admin role must be rejected");
        assert(/only an admin/i.test(error.message), `expected an admin-only rejection, got: ${error.message}`);

        const { count } = await db.from("sources").select("*", { count: "exact", head: true }).eq("id", sourceId);
        assertEquals(count, 1, "the source must still exist after a rejected attempt");
      });

      await runStep("an authenticated non-editor cannot purge a source", async () => {
        const sourceId = await trackedSource(`T-authgate-outsider-${stamp}`);
        const { error } = await outsiderClient.rpc("purge_source", { p_source_id: sourceId });
        assert(error, "someone not on the editors allowlist at all must be rejected");
        assert(/only an admin/i.test(error.message), `expected an admin-only rejection, got: ${error.message}`);
      });

      await runStep("an admin purging a nonexistent source gets a clear not-found error", async () => {
        const { error } = await adminClient.rpc("purge_source", { p_source_id: crypto.randomUUID() });
        assert(error, "a random uuid must not silently succeed");
        assert(/not found/i.test(error.message), `expected a not-found error, got: ${error.message}`);
      });

      // =====================================================================
      // CITATION BLOCK — the one check the schema cannot enforce on its own
      // =====================================================================
      await runStep(
        "an admin is refused when a source's posts are cited in generated copy, naming the result and its approval status",
        async () => {
          const sourceId = await trackedSource(`T-citation-block-${stamp}`);
          const { rawPostId, clusteringRunId, clusterId } = await buildClusteredPost(sourceId, "citation-block cluster");
          const resultId = await makeBlockingResult(rawPostId, clusteringRunId, clusterId, "citation-block cluster", true);

          const { error } = await adminClient.rpc("purge_source", { p_source_id: sourceId });
          assert(error, "a source cited in generated copy must be refused, even for an admin");
          assert(/cited in generated copy/i.test(error.message), `expected a citation refusal, got: ${error.message}`);
          assert(error.message.includes("citation-block cluster"), "the refusal must name the blocking cluster_label");
          assert(/"approved":\s*true/i.test(error.message), "the refusal must report that the citing result is approved");
          assert(error.message.includes(resultId), "the refusal must name the specific result_id");

          // Nothing was touched — the refusal happens before any delete runs.
          const { count: sourceCount } = await db.from("sources").select("*", { count: "exact", head: true }).eq("id", sourceId);
          assertEquals(sourceCount, 1);
          const { count: postCount } = await db.from("raw_posts").select("*", { count: "exact", head: true }).eq("id", rawPostId);
          assertEquals(postCount, 1);
          const { count: resultCount } = await db
            .from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("id", resultId);
          assertEquals(resultCount, 1);
        },
      );

      // =====================================================================
      // CLEAN PURGE — regression test for the 0028 fix
      // =====================================================================
      await runStep(
        "an admin cleanly purges a scored, anonymised, embedded source, and every touched table ends up empty",
        async () => {
          const sourceId = await trackedSource(`T-clean-purge-${stamp}`);
          const requestId = await makeScoringRequest();

          // Post A: the full success chain — scored, promoted, anonymised,
          // embedded and clustered. This is exactly the shape 0026 could
          // never purge before 0028 (scoring_results + anonymize_results both
          // carry a real row).
          const postA = await makeRawPost(sourceId, "post A — the full success chain");
          await scoreAndPromote(postA, requestId);
          const resultIdA = await anonymizeAndComplete(postA);
          await embedIntoNewRun(postA, resultIdA);

          // Post B: scored + promoted, then its anonymize job dead-letters —
          // covers anonymize_job_state(dead_letter) + anonymize_dead_letter.
          const postB = await makeRawPost(sourceId, "post B — anonymize dead-letters");
          await scoreAndPromote(postB, requestId);
          await anonymizeAndDeadLetter(postB);

          // Post C: scoring itself dead-letters — never promoted, never
          // eligible for anonymisation. Covers scoring_job_state(dead_letter)
          // + scoring_dead_letter.
          const postC = await makeRawPost(sourceId, "post C — scoring dead-letters");
          await scoreAndDeadLetter(postC, requestId);

          await makeIngestRunSource(sourceId);

          const { data, error } = await adminClient.rpc("purge_source", { p_source_id: sourceId });
          assert(!error, `a clean purge must succeed: ${error?.message}`);
          assertEquals(data.source, `T-clean-purge-${stamp}`);
          assertEquals(data.raw_posts, 3, "posts A, B and C");
          assertEquals(data.scoring_results, 2, "A and B were both scored successfully");
          assertEquals(data.scoring_job_state, 3, "one job per post");
          assertEquals(data.scoring_dead_letter, 1, "C only");
          assertEquals(data.anonymize_results, 1, "A only");
          assertEquals(data.anonymize_job_state, 2, "A succeeded, B dead-lettered");
          assertEquals(data.anonymize_dead_letter, 1, "B only");
          assertEquals(data.clustering_run_posts, 1, "A only");
          assertEquals(data.ingest_run_sources, 1);

          // The regression check itself: every table purge_source claims to
          // have emptied is actually empty, not just a jsonb count that looks
          // right. This is what would have stayed red against 0026 alone —
          // the RPC call above would have thrown before returning at all.
          const postIds = [postA, postB, postC];
          const { count: rawPostCount, error: rawPostErr } = await db
            .from("raw_posts").select("*", { count: "exact", head: true }).in("id", postIds);
          assert(!rawPostErr, `raw_posts query failed: ${rawPostErr?.message}`);
          assertEquals(rawPostCount, 0, "raw_posts must have zero rows for this source's posts after purge");

          for (
            const table of [
              "scoring_results", "scoring_job_state", "scoring_dead_letter",
              "anonymize_results", "anonymize_job_state", "anonymize_dead_letter",
              "clustering_run_posts", "anonymized_posts_current",
            ] as const
          ) {
            const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).in("raw_post_id", postIds);
            assert(!error, `${table} query failed: ${error?.message}`);
            assertEquals(count, 0, `${table} must have zero rows for this source's posts after purge`);
          }

          const { count: embedCount } = await db
            .from("post_embeddings").select("*", { count: "exact", head: true }).eq("raw_post_id", postA);
          assertEquals(embedCount, 0, "post_embeddings cascades away when anonymize_results is deleted");

          const { count: ingestCount } = await db
            .from("ingest_run_sources").select("*", { count: "exact", head: true }).eq("source_id", sourceId);
          assertEquals(ingestCount, 0);

          const { count: sourceCount } = await db.from("sources").select("*", { count: "exact", head: true }).eq("id", sourceId);
          assertEquals(sourceCount, 0, "the source row itself is gone");
        },
      );
    } finally {
      await t.step("zzz teardown", teardown);
    }
  },
});

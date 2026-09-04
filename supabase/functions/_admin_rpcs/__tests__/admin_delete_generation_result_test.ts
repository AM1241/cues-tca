/**
 * Whole-flow tests for the admin_delete_generation_result RPC (0027) against
 * the LOCAL Supabase stack.
 *
 * Like purge_source, this RPC has no Edge Function handler — the frontend
 * calls it directly via PostgREST RPC — so this suite does the same, through
 * per-role AUTHENTICATED clients (anon key + a real signed-in session).
 * cluster_generation_results itself is append-only for every OTHER caller
 * (0016's trigger, unconditionally, still): this RPC is the one deliberate
 * admin exception, gated by a transaction-local flag nothing else can set.
 *
 * Run (from the repo root):
 *   docker run --rm --network supabase_network_cues-editorial-cloud \
 *     -v "$PWD/supabase/functions:/app" -w /app \
 *     -e SUPABASE_URL=http://kong:8000 -e SUPABASE_ANON_KEY=... \
 *     -e SUPABASE_SERVICE_ROLE_KEY=... \
 *     denoland/deno:alpine-2.5.2 deno test --allow-env --allow-net _admin_rpcs/__tests__/admin_delete_generation_result_test.ts
 *
 * Skipped automatically when SUPABASE_URL/ANON/SERVICE_ROLE are absent.
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { LIVE, db, actingAs, makeUser, makeSource, buildClusteredPost } from "./fixtures.ts";

const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const emails = {
  admin: `adr-admin.${stamp}@cues.test`,
  editor: `adr-editor.${stamp}@cues.test`,
  outsider: `adr-outsider.${stamp}@cues.test`,
};
const tokens: Record<string, string> = {};
const userIds: string[] = [];
let adminClient: SupabaseClient;
let editorClient: SupabaseClient;
let outsiderClient: SupabaseClient;

const sourceIds: string[] = [];

async function trackedSource(name: string): Promise<string> {
  const id = await makeSource(name);
  sourceIds.push(id);
  return id;
}

/** One clustered post + one generated 'post' result over it, draft by default. */
async function makeResult(sourceId: string, label: string): Promise<{ resultId: string; clusteringRunId: string; clusterId: string; rawPostId: string }> {
  const { rawPostId, clusteringRunId, clusterId } = await buildClusteredPost(sourceId, label);
  const { data: reqId, error } = await db.rpc("create_cluster_generation_request", {
    p_clustering_run_id: clusteringRunId, p_requested_cluster_ids: [clusterId], p_output_types: ["post"],
  });
  if (error) throw error;
  const { data: resultId, error: e2 } = await db.rpc("complete_cluster_generation_result", {
    p_request_id: reqId, p_cluster_id: clusterId, p_cluster_label: label,
    p_raw_post_ids: [rawPostId], p_anonymize_result_ids: [crypto.randomUUID()],
    p_output_types: ["post"], p_post_output: { text: `generated copy for ${label}` }, p_carousel_output: null,
    p_config_snapshot: {}, p_prompt_version: "v1", p_prompt_hash: "h", p_model: "gpt-test",
  });
  if (e2) throw e2;
  const { error: e3 } = await db.rpc("finish_cluster_generation_request", { p_request_id: reqId });
  if (e3) throw e3;
  return { resultId: resultId as string, clusteringRunId, clusterId, rawPostId };
}

async function approve(resultId: string): Promise<void> {
  const { error } = await db.from("cluster_generation_reviews")
    .update({ status: "approved" }).eq("result_id", resultId).eq("output_type", "post");
  if (error) throw error;
}

/** A second result over the SAME cluster, recorded as a regeneration of `oldResultId`. */
async function regenerate(clusteringRunId: string, clusterId: string, oldResultId: string, label: string): Promise<string> {
  const { data: reqId, error } = await db.rpc("create_cluster_generation_request", {
    p_clustering_run_id: clusteringRunId, p_requested_cluster_ids: [clusterId], p_output_types: ["post"],
    p_feedback: "make it punchier", p_regenerates_result_id: oldResultId,
  });
  if (error) throw error;
  const { data: resultId, error: e2 } = await db.rpc("complete_cluster_generation_result", {
    p_request_id: reqId, p_cluster_id: clusterId, p_cluster_label: label,
    p_raw_post_ids: [crypto.randomUUID()], p_anonymize_result_ids: [crypto.randomUUID()],
    p_output_types: ["post"], p_post_output: { text: `regenerated copy for ${label}` }, p_carousel_output: null,
    p_config_snapshot: {}, p_prompt_version: "v1", p_prompt_hash: "h", p_model: "gpt-test",
  });
  if (e2) throw e2;
  const { error: e3 } = await db.rpc("finish_cluster_generation_request", { p_request_id: reqId });
  if (e3) throw e3;
  return resultId as string;
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

  // Everything not already deleted by the tests themselves is real pipeline
  // history (scoring_results / anonymize_results / cluster_generation_results
  // all grant service_role SELECT only) and cannot be force-cleaned here —
  // same discipline as purge_source_test.ts and score-worker's own suite.
  for (const id of sourceIds) {
    const { error } = await db.from("sources").delete().eq("id", id);
    if (error && error.code !== "23503") failures.push(`sources ${id}: ${error.message}`);
    else if (error) retained.push(`sources ${id}: retained (FK-restricted by real pipeline history, by design)`);
  }

  for (const id of userIds) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) failures.push(`auth user ${id}: ${error.message}`);
  }

  if (retained.length) console.warn(`[admin_delete_generation_result teardown] retained:\n  - ${retained.join("\n  - ")}`);
  if (failures.length) throw new Error(`teardown hit unexpected errors:\n  - ${failures.join("\n  - ")}`);
}

Deno.test({
  name: "[admin_delete_generation_result] whole flow",
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
      await runStep("a non-admin editor cannot delete a generated result", async () => {
        const sourceId = await trackedSource(`T-authgate-editor-${stamp}`);
        const { resultId } = await makeResult(sourceId, "authgate editor cluster");
        const { error } = await editorClient.rpc("admin_delete_generation_result", { p_result_id: resultId });
        assert(error, "an editor without admin role must be rejected");
        assert(/only an admin/i.test(error.message), `expected an admin-only rejection, got: ${error.message}`);

        const { count } = await db.from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("id", resultId);
        assertEquals(count, 1, "the result must still exist after a rejected attempt");
      });

      await runStep("an authenticated non-editor cannot delete a generated result", async () => {
        const sourceId = await trackedSource(`T-authgate-outsider-${stamp}`);
        const { resultId } = await makeResult(sourceId, "authgate outsider cluster");
        const { error } = await outsiderClient.rpc("admin_delete_generation_result", { p_result_id: resultId });
        assert(error, "someone not on the editors allowlist at all must be rejected");
        assert(/only an admin/i.test(error.message), `expected an admin-only rejection, got: ${error.message}`);
      });

      await runStep("an admin deleting a nonexistent result gets a clear not-found error", async () => {
        const { error } = await adminClient.rpc("admin_delete_generation_result", { p_result_id: crypto.randomUUID() });
        assert(error, "a random uuid must not silently succeed");
        assert(/not found/i.test(error.message), `expected a not-found error, got: ${error.message}`);
      });

      // =====================================================================
      // CORE BEHAVIOUR
      // =====================================================================
      await runStep("an admin cleanly deletes a draft result and its review row", async () => {
        const sourceId = await trackedSource(`T-delete-draft-${stamp}`);
        const { resultId } = await makeResult(sourceId, "draft-delete cluster");

        const { data, error } = await adminClient.rpc("admin_delete_generation_result", { p_result_id: resultId });
        assert(!error, `deleting a draft result must succeed: ${error?.message}`);
        assertEquals(data.was_approved, false);
        assertEquals(data.reviews_removed, 1, "one review row, for the 'post' output type");
        assertEquals(data.regeneration_links_cleared, 0);
        assertEquals(data.superseded_links_cleared, 0);

        const { count: resultCount } = await db.from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("id", resultId);
        assertEquals(resultCount, 0);
        const { count: reviewCount } = await db.from("cluster_generation_reviews").select("*", { count: "exact", head: true }).eq("result_id", resultId);
        assertEquals(reviewCount, 0);
      });

      await runStep("an admin deletes an APPROVED result too, and reports it was approved", async () => {
        const sourceId = await trackedSource(`T-delete-approved-${stamp}`);
        const { resultId } = await makeResult(sourceId, "approved-delete cluster");
        await approve(resultId);

        const { data: before } = await db.from("cluster_generation_reviews").select("status").eq("result_id", resultId).eq("output_type", "post").single();
        assertEquals(before!.status, "approved", "sanity check: the fixture really is approved before deletion");

        const { data, error } = await adminClient.rpc("admin_delete_generation_result", { p_result_id: resultId });
        assert(!error, `deleting an approved result must succeed for an admin: ${error?.message}`);
        assertEquals(data.was_approved, true, "the RPC must report that the deleted result had been approved");

        const { count: resultCount } = await db.from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("id", resultId);
        assertEquals(resultCount, 0, "even an approved result is actually gone — this is the one deliberate exception to append-only");
      });

      // =====================================================================
      // POINTER CLEARING — both directions, each proven to actually fire
      // =====================================================================
      await runStep(
        "deleting an old result clears a newer regeneration's back-reference to it",
        async () => {
          const sourceId = await trackedSource(`T-clear-regen-${stamp}`);
          const { resultId: oldId, clusteringRunId, clusterId } = await makeResult(sourceId, "regen-link cluster");
          const newId = await regenerate(clusteringRunId, clusterId, oldId, "regen-link cluster");

          const { data: reqBefore } = await db.from("cluster_generation_requests")
            .select("id, regenerates_result_id").eq("regenerates_result_id", oldId).single();
          assert(reqBefore, "sanity check: the new request really does point back at the old result before deletion");

          const { data, error } = await adminClient.rpc("admin_delete_generation_result", { p_result_id: oldId });
          assert(!error, `deleting the old (regenerated-from) result must succeed: ${error?.message}`);
          assertEquals(data.regeneration_links_cleared, 1);
          assertEquals(data.superseded_links_cleared, 0, "no review pointed AT the old result as its superseder here");

          const { data: reqAfter } = await db.from("cluster_generation_requests")
            .select("regenerates_result_id").eq("id", reqBefore!.id).single();
          assertEquals(reqAfter!.regenerates_result_id, null, "the dangling back-reference must be nulled, not left pointing at a deleted row");

          // The newer result itself is completely untouched by deleting the older one.
          const { count: newStillThere } = await db.from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("id", newId);
          assertEquals(newStillThere, 1);
        },
      );

      await runStep(
        "deleting a result clears any review's dangling superseded_by_result_id pointer to it",
        async () => {
          const sourceId = await trackedSource(`T-clear-superseded-${stamp}`);
          const { resultId: oldId, clusteringRunId, clusterId } = await makeResult(sourceId, "superseded-link cluster");
          const newId = await regenerate(clusteringRunId, clusterId, oldId, "superseded-link cluster");

          // Point the OLD result's own review at the NEW one, exactly as
          // `generate` does once a regeneration lands (0023).
          const { error: supErr } = await db.rpc("supersede_generation_review", {
            p_old_result_id: oldId, p_output_type: "post", p_new_result_id: newId,
          });
          if (supErr) throw supErr;

          const { data: reviewBefore } = await db.from("cluster_generation_reviews")
            .select("superseded_by_result_id, status").eq("result_id", oldId).eq("output_type", "post").single();
          assertEquals(reviewBefore!.superseded_by_result_id, newId, "sanity check: the old review really does point at the new result");

          // Now delete the NEW result — the one referenced AS a superseder.
          // This is the "rigged" direction: naturally this happens when an
          // admin cleans up a result that itself replaced something earlier.
          const { data, error } = await adminClient.rpc("admin_delete_generation_result", { p_result_id: newId });
          assert(!error, `deleting the newer (superseding) result must succeed: ${error?.message}`);
          assertEquals(data.superseded_links_cleared, 1);

          const { data: reviewAfter } = await db.from("cluster_generation_reviews")
            .select("superseded_by_result_id, status").eq("result_id", oldId).eq("output_type", "post").single();
          assert(reviewAfter, "the OLD result's own review row must survive — only the NEW result was deleted");
          assertEquals(reviewAfter!.superseded_by_result_id, null, "the dangling pointer to the deleted superseding result must be nulled");
          assertEquals(reviewAfter!.status, "superseded", "status itself is untouched by the pointer clearing, only the dangling reference is");
        },
      );

      // =====================================================================
      // DEFENCE IN DEPTH — the append-only guard still holds for every other path
      // =====================================================================
      await runStep(
        "a raw UPDATE or DELETE on cluster_generation_results is still rejected at the grant level, before the trigger even runs",
        async () => {
          const sourceId = await trackedSource(`T-grant-defence-${stamp}`);
          const { resultId } = await makeResult(sourceId, "grant-defence cluster");

          const { error: updateErr } = await db.from("cluster_generation_results")
            .update({ cluster_label: "tampered" }).eq("id", resultId);
          assert(updateErr, "a raw UPDATE must be rejected even for service_role — no UPDATE grant exists on this table");
          assert(/permission denied/i.test(updateErr.message), `expected a permission-denied error, got: ${updateErr.message}`);

          const { error: deleteErr } = await db.from("cluster_generation_results").delete().eq("id", resultId);
          assert(deleteErr, "a raw DELETE must be rejected too — only admin_delete_generation_result may ever delete this table");
          assert(/permission denied/i.test(deleteErr.message), `expected a permission-denied error, got: ${deleteErr.message}`);

          const { count } = await db.from("cluster_generation_results").select("*", { count: "exact", head: true }).eq("id", resultId);
          assertEquals(count, 1, "untouched by either rejected attempt");
        },
      );
    } finally {
      await t.step("zzz teardown", teardown);
    }
  },
});

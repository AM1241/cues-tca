/**
 * Whole-flow tests for the anonymize-worker handler against the LOCAL
 * Supabase stack. OpenAI is always scripted; OPENAI_API_KEY is set to a dummy
 * value precisely so a real call would fail loudly rather than quietly
 * succeed.
 *
 * Sized to PHASE4_REQUIREMENTS.md §4's "small, focused" bar — this is
 * deliberately NOT a repeat of score-worker's 32-step hardening suite.
 * Anonymisation has no shared "request" (see 0014's migration header), so
 * there is no circuit-break or request-first lock-order surface to test here
 * at all; the scope is: auth, request validation, the two-stage
 * (deterministic + LLM) happy path, idempotency, fail-loud failure behavior,
 * and the lease/superseded guard.
 *
 * Run (from the repo root), mirroring score-worker/__tests__/handler_test.ts:
 *   docker run --rm --network supabase_network_cues-editorial-cloud \
 *     -v "$PWD/supabase/functions:/app" -w /app \
 *     -e SUPABASE_URL=http://kong:8000 -e SUPABASE_ANON_KEY=... \
 *     -e SUPABASE_SERVICE_ROLE_KEY=... -e OPENAI_API_KEY=dummy-not-used \
 *     -e INGEST_INTERNAL_SECRET=... \
 *     denoland/deno:alpine-2.5.2 deno test --allow-env --allow-net anonymize-worker/__tests__/
 *
 * Skipped automatically when SUPABASE_URL is absent.
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handleAnonymizeWorker } from "../index.ts";
import { scriptedOpenAi } from "./fixtures.ts";
import { OpenAiError } from "../../_shared/openai.ts";

const URL_ = Deno.env.get("SUPABASE_URL");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const LIVE = Boolean(URL_ && SERVICE);
const INTERNAL_SECRET = Deno.env.get("INGEST_INTERNAL_SECRET") ?? "";

const db: SupabaseClient = LIVE
  ? createClient(URL_!, SERVICE!, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    })
  : (null as unknown as SupabaseClient);

const runTag = `T-anon-${Date.now()}-${crypto.randomUUID()}`;
let sourceId = "";
const rawPostIds: string[] = [];
let hadDefaultConfig = false;

function request(body: unknown, apikey?: string): Request {
  return new Request("https://local.test/anonymize-worker", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apikey ? { apikey } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

/** Insert a scored raw_post (source + raw_posts + a fake current scoring_result
 *  + analyzed_posts row), which is the precondition backfill_anonymize_jobs
 *  and complete_anonymize_job both read from (overall_relevance, source name). */
async function makeScoredPost(text: string, overallRelevance = 80): Promise<string> {
  const { data: rp, error: rpErr } = await db
    .from("raw_posts")
    .insert({
      source_id: sourceId,
      source_url: `https://example.test/post-${crypto.randomUUID()}`,
      external_post_id: crypto.randomUUID(),
      post_text: text,
      published_at: new Date().toISOString(),
    })
    .select("id").single();
  if (rpErr) throw rpErr;
  const rawPostId = rp.id as string;
  rawPostIds.push(rawPostId);

  const { data: reqId, error: reqErr } = await db.rpc("create_scoring_request", {
    p_purpose: "evaluation",
    p_prompt_version: "scoring_v1",
    p_prompt_hash: "test-hash",
    p_config_snapshot: { themes: [{ theme_id: "sustainability", label: "sustainability", position: 1 }], min_relevance_score: 50 },
    p_model: "gpt-test",
    p_model_snapshot: "gpt-test-2026-01-01",
    p_aggregation_strategy: "max_theme_v1",
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

  // complete_scoring_job only writes the append-only scoring_results history;
  // analyzed_posts.current_result_id (what backfill_anonymize_jobs reads) is
  // only set by the separate promotion step, set_current_scoring_result.
  const { data: scoreRow, error: scoreRowErr } = await db
    .from("scoring_results").select("id").eq("raw_post_id", rawPostId).eq("scoring_request_id", reqId).single();
  if (scoreRowErr) throw scoreRowErr;
  const { error: promoteErr } = await db.rpc("set_current_scoring_result", {
    p_raw_post_id: rawPostId, p_result_id: scoreRow!.id,
  });
  if (promoteErr) throw promoteErr;

  await db.rpc("close_scoring_request", { p_request_id: reqId });

  return rawPostId;
}

async function requireSchema() {
  const { error: rpcErr } = await db.rpc("read_anonymize_jobs", { p_vt: 1, p_qty: 0 });
  if (rpcErr) throw new Error(`required RPC public.read_anonymize_jobs is missing or broken: ${rpcErr.message}`);
  for (const table of ["anonymize_job_state", "anonymize_results", "anonymize_dead_letter", "anonymized_posts_current"]) {
    const { error } = await db.from(table).select("*", { head: true, count: "exact" });
    if (error) throw new Error(`required table public.${table} is missing or unreachable: ${error.message}`);
  }
}

/** anonymize_jobs is shared Postgres state; claim whatever is currently
 *  visible so a leftover from an interrupted run doesn't pollute this run's
 *  batch counts (mirrors score-worker's drainAmbientQueueNoise). */
async function drainAmbientQueueNoise() {
  await db.rpc("read_anonymize_jobs", { p_vt: 120, p_qty: 1000 });
}

async function setup() {
  await requireSchema();
  await drainAmbientQueueNoise();

  // configurations is a single id='default' row that the legacy loader seeds,
  // not the migrations themselves — absent on a fresh local db reset with no
  // legacy seed loaded. Create it if missing; only clean it up in teardown if
  // this run created it, never touching a pre-existing operator row.
  const { data: existing } = await db.from("configurations").select("id").eq("id", "default").maybeSingle();
  if (!existing) {
    const { error } = await db.from("configurations").insert({
      id: "default", min_relevance_score: 50,
      anonymization_enabled: true, anonymize_companies: true, keep_public_bodies: true,
      company_aliases: {},
    });
    if (error) throw error;
    hadDefaultConfig = false;
  } else {
    hadDefaultConfig = true;
  }

  const { data: src, error: srcErr } = await db
    .from("sources")
    .insert({ name: runTag, source_type: "linkedin", url: "https://example.test", enabled: true })
    .select("id").single();
  if (srcErr) throw srcErr;
  sourceId = src.id as string;
}

const FK_RESTRICT_VIOLATION = "23503";

async function teardown() {
  const failures: string[] = [];

  if (rawPostIds.length) {
    const { error: apcErr } = await db.from("anonymized_posts_current").delete().in("raw_post_id", rawPostIds);
    if (apcErr) failures.push(`anonymized_posts_current cleanup: ${apcErr.message}`);
    // anonymize_results / anonymize_job_state / anonymize_dead_letter: no
    // DELETE grant to service_role (0014, mirrors 0005) — nothing to attempt.

    const { error: apErr } = await db.from("analyzed_posts").delete().in("raw_post_id", rawPostIds);
    if (apErr) failures.push(`analyzed_posts cleanup: ${apErr.message}`);

    const { error: rpErr } = await db.from("raw_posts").delete().in("id", rawPostIds);
    if (rpErr && rpErr.code !== FK_RESTRICT_VIOLATION) failures.push(`raw_posts cleanup: ${rpErr.message}`);
  }

  if (sourceId) {
    const { error: srcErr } = await db.from("sources").delete().eq("id", sourceId);
    if (srcErr && srcErr.code !== FK_RESTRICT_VIOLATION) failures.push(`sources cleanup: ${srcErr.message}`);
  }

  if (!hadDefaultConfig) {
    const { error: cfgErr } = await db.from("configurations").delete().eq("id", "default");
    if (cfgErr) failures.push(`configurations cleanup: ${cfgErr.message}`);
  }

  const retained: string[] = [];
  if (rawPostIds.length) {
    const { count } = await db.from("anonymize_job_state").select("*", { count: "exact", head: true }).in("raw_post_id", rawPostIds);
    retained.push(`anonymize_job_state: ${count ?? 0} row(s) retained under run tag ${runTag} (service_role has no DELETE grant)`);
    const { count: resCount } = await db.from("anonymize_results").select("*", { count: "exact", head: true }).in("raw_post_id", rawPostIds);
    retained.push(`anonymize_results: ${resCount ?? 0} row(s) retained under run tag ${runTag} (append-only by design, 0014 trigger)`);
  }
  if (retained.length) console.warn(`[anonymize-worker teardown] retained-row report for run tag ${runTag}:\n  - ${retained.join("\n  - ")}`);

  if (failures.length) throw new Error(`teardown hit unexpected errors:\n  - ${failures.join("\n  - ")}`);
}

async function backfillAndClaim(): Promise<void> {
  const { error } = await db.rpc("backfill_anonymize_jobs", { p_min_relevance: null });
  if (error) throw error;
}

Deno.test({
  name: "[anonymize-worker] whole flow",
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
      await runStep("no credentials -> 401", async () => {
        const res = await handleAnonymizeWorker(request({}), { db });
        assertEquals(res.status, 401);
      });

      await runStep("wrong internal secret -> 401", async () => {
        const res = await handleAnonymizeWorker(request({}, "not-the-secret"), { db });
        assertEquals(res.status, 401);
      });

      // =====================================================================
      // REQUEST VALIDATION
      // =====================================================================
      await runStep("batch_size out of range -> 400", async () => {
        const res = await handleAnonymizeWorker(request({ batch_size: 0 }, INTERNAL_SECRET), { db });
        assertEquals(res.status, 400);
      });

      await runStep("no jobs queued -> ok with zero totals", async () => {
        await drainAmbientQueueNoise();
        const { callOpenAiImpl, calls } = scriptedOpenAi([]);
        const res = await handleAnonymizeWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.totals.jobs_read, 0);
        assertEquals(calls.length, 0);
      });

      // =====================================================================
      // HAPPY PATH — deterministic + LLM entity findings both land in the
      // replacements audit trail; anonymized_posts_current advances.
      // =====================================================================
      await runStep(
        "anonymizes a job end to end, merging deterministic + LLM entity replacements",
        async () => {
          await drainAmbientQueueNoise();
          const rawPostId = await makeScoredPost(`${runTag} announces a partnership with Acme Foods Ltd today.`);
          await backfillAndClaim();

          const { callOpenAiImpl, calls } = scriptedOpenAi([{ entities: ["Acme Foods Ltd"] }]);
          const res = await handleAnonymizeWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
          assertEquals(res.status, 200);
          const body = await res.json();
          assertEquals(body.totals.anonymized, 1);
          assertEquals(calls.length, 1);

          const { data: current } = await db
            .from("anonymized_posts_current").select("*").eq("raw_post_id", rawPostId).single();
          assert(current, "anonymized_posts_current row was written");
          assert(!current!.anonymized_text.includes(runTag), "source name was replaced");
          assert(!current!.anonymized_text.includes("Acme Foods Ltd"), "LLM-found entity was replaced");
          assert(current!.current_result_id, "current_result_id points at the append-only result");

          const replacementSources = (current!.replacements as { source: string }[]).map((r) => r.source);
          assert(replacementSources.includes("source_name"), "deterministic replacement recorded");
          assert(replacementSources.includes("entity_extraction"), "LLM entity replacement recorded");

          const { data: result } = await db
            .from("anonymize_results").select("entity_extraction_used").eq("id", current!.current_result_id).single();
          assertEquals(result!.entity_extraction_used, true);
        },
      );

      await runStep("a second drain of the same completed job does not double-write", async () => {
        await drainAmbientQueueNoise();
        const rawPostId = await makeScoredPost(`${runTag} publishes an update.`);
        await backfillAndClaim();
        const { callOpenAiImpl } = scriptedOpenAi([{ entities: [] }]);
        await handleAnonymizeWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });

        // Nothing new queued (already succeeded) — a second backfill+drain is a no-op.
        await backfillAndClaim();
        const { callOpenAiImpl: secondImpl, calls } = scriptedOpenAi([]);
        const res = await handleAnonymizeWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl: secondImpl });
        assertEquals((await res.json()).totals.jobs_read, 0, "already-succeeded post is not re-enqueued by backfill");
        assertEquals(calls.length, 0);

        const { count } = await db.from("anonymize_results").select("*", { count: "exact", head: true }).eq("raw_post_id", rawPostId);
        assertEquals(count, 1, "exactly one result, no duplicate");
      });

      // =====================================================================
      // FAILURE HANDLING — fail-loud: no silent fallback, ever
      // =====================================================================
      await runStep(
        "an LLM entity-extraction failure dead-letters the job and never advances anonymized_posts_current",
        async () => {
          await drainAmbientQueueNoise();
          const rawPostId = await makeScoredPost(`${runTag} post that trips a scripted failure.`);
          await backfillAndClaim();
          const { callOpenAiImpl } = scriptedOpenAi([{ throws: "server_error" }]);

          const res = await handleAnonymizeWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
          const body = await res.json();
          assertEquals(body.totals.retried, 1, "first failure retries, does not dead-letter immediately (3-strike backoff)");

          const { data: current } = await db
            .from("anonymized_posts_current").select("*").eq("raw_post_id", rawPostId).maybeSingle();
          assertEquals(current, null, "no anonymized_posts_current row under a failed attempt");

          const { count } = await db.from("anonymize_results").select("*", { count: "exact", head: true }).eq("raw_post_id", rawPostId);
          assertEquals(count, 0, "a failed attempt never writes a result row");
        },
      );

      await runStep("one job's failure does not abort the batch", async () => {
        await drainAmbientQueueNoise();
        // pgmq claim order is not guaranteed to match insertion order, so this
        // test must not assume which of the two posts the scripted "call 1
        // throws" lands on — it only asserts on the batch totals and on
        // whichever post the response itself reports as succeeded/retried.
        await makeScoredPost(`${runTag} first post fails.`);
        await makeScoredPost(`${runTag} second post succeeds fine.`);
        await backfillAndClaim();

        let call = 0;
        const callOpenAiImpl = (async () => {
          call++;
          if (call === 1) {
            throw new OpenAiError("timeout", "scripted timeout");
          }
          return { parsed: { entities: [] }, raw: {} };
        }) as typeof import("../../_shared/openai.ts").callOpenAi;

        const res = await handleAnonymizeWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.jobs_read, 2);
        assertEquals(body.totals.anonymized, 1);
        assertEquals(body.totals.retried, 1);

        const okResult = body.results.find((r: { status: string }) => r.status === "anonymized");
        const retriedResult = body.results.find((r: { status: string }) => r.status === "retry");
        assert(okResult, "exactly one job reports anonymized");
        assert(retriedResult, "exactly one job reports retry");

        const { data: okCurrent } = await db
          .from("anonymized_posts_current").select("raw_post_id").eq("raw_post_id", okResult.raw_post_id).maybeSingle();
        assert(okCurrent, "the succeeding job actually wrote anonymized_posts_current");

        const { data: failingJob } = await db
          .from("anonymize_job_state").select("status").eq("raw_post_id", retriedResult.raw_post_id).single();
        assertEquals(failingJob!.status, "pending", "left retryable, not silently dropped");
      });

      // =====================================================================
      // LEASE / OWNERSHIP
      // =====================================================================
      await runStep("only the current lease holder can complete; a stale token is superseded", async () => {
        await drainAmbientQueueNoise();
        const rawPostId = await makeScoredPost(`${runTag} lease test post.`);
        await backfillAndClaim();

        const { data: claimed } = await db.rpc("read_anonymize_jobs", { p_vt: 120, p_qty: 50 });
        const mine = (claimed as { msg_id: number; message: { job_id: string; raw_post_id: string }; processing_token: string }[])
          .find((m) => m.message.raw_post_id === rawPostId)!;
        assert(mine?.processing_token, "the claim stamped a processing_token");

        const args = {
          p_job_id: mine.message.job_id, p_msg_id: mine.msg_id, p_raw_post_id: rawPostId,
          p_anonymized_text: "irrelevant", p_replacements: [], p_generalized_source_name: "x",
          p_entity_extraction_used: true, p_config_snapshot: {},
        };
        const { data: stale } = await db.rpc("complete_anonymize_job", { ...args, p_processing_token: crypto.randomUUID() });
        assertEquals(stale, "superseded");

        const { count } = await db.from("anonymize_results").select("*", { count: "exact", head: true }).eq("raw_post_id", rawPostId);
        assertEquals(count, 0, "a superseded completion writes nothing");

        const { data: ok } = await db.rpc("complete_anonymize_job", { ...args, p_processing_token: mine.processing_token });
        assertEquals(ok, "inserted");
      });

      // =====================================================================
      // FAIL-LOUD GUARD — completing without a real entity pass must raise
      // =====================================================================
      await runStep("complete_anonymize_job rejects entity_extraction_used=false", async () => {
        await drainAmbientQueueNoise();
        const rawPostId = await makeScoredPost(`${runTag} guard test post.`);
        await backfillAndClaim();
        const { data: claimed } = await db.rpc("read_anonymize_jobs", { p_vt: 120, p_qty: 50 });
        const mine = (claimed as { msg_id: number; message: { job_id: string; raw_post_id: string }; processing_token: string }[])
          .find((m) => m.message.raw_post_id === rawPostId)!;

        const { error } = await db.rpc("complete_anonymize_job", {
          p_job_id: mine.message.job_id, p_msg_id: mine.msg_id, p_raw_post_id: rawPostId,
          p_anonymized_text: "partial", p_replacements: [], p_generalized_source_name: "x",
          p_entity_extraction_used: false, p_config_snapshot: {}, p_processing_token: mine.processing_token,
        });
        assert(error, "completing with entity_extraction_used=false must raise, never silently succeed");
      });
    } finally {
      await t.step("zzz teardown", teardown);
    }
  },
});

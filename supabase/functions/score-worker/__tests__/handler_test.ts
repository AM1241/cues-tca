/**
 * Whole-flow tests for the score-worker handler against the LOCAL Supabase
 * stack. OpenAI is always scripted; OPENAI_API_KEY is set to a dummy value
 * precisely so a real call would fail loudly rather than quietly succeed.
 *
 * Run (from the repo root), mirroring ingest/__tests__/handler_test.ts:
 *   docker run --rm --network supabase_network_cues-editorial-cloud \
 *     -v "$PWD/supabase/functions:/app" -w /app \
 *     -e SUPABASE_URL=http://kong:8000 -e SUPABASE_ANON_KEY=... \
 *     -e SUPABASE_SERVICE_ROLE_KEY=... -e OPENAI_API_KEY=dummy-not-used \
 *     -e INGEST_INTERNAL_SECRET=... \
 *     denoland/deno:alpine-2.5.2 deno test --allow-env --allow-net score-worker/__tests__/
 *
 * All 16 test cases + setup + teardown run as `t.step(...)` inside ONE parent
 * `Deno.test`, so teardown executes from a real `finally` under normal
 * in-process test execution — not merely because it happens to be the last
 * `Deno.test` registered. Expected successful result: 1 parent test, 18
 * steps (`000 setup` + 16 functional steps + `zzz teardown`), 0 failed.
 * "Teardown runs through `finally`" means specifically: under normal
 * in-process test execution, where the JS event loop keeps running long
 * enough to reach the `finally` block. This does NOT protect against the
 * process itself being killed (an outer Docker/shell timeout, Ctrl-C, OOM),
 * the Deno runtime crashing, or a module-load failure before this test even
 * registers; nothing inside the process runs after any of those, teardown
 * included — only an outer process-level timeout bounds those cases (see the
 * `docker run` invocation above).
 *
 * `sanitizeOps`/`sanitizeResources` are left at their Deno defaults (enabled)
 * — normal leak detection must catch a real bug in this file. The Supabase
 * client is created with autoRefreshToken/detectSessionInUrl disabled
 * specifically so it never starts an internal timer that would otherwise
 * cross a test's op-sanitizer boundary.
 *
 * The `scoring_jobs` pgmq queue is shared Postgres state, not scoped to this
 * suite or even this run — `drainAmbientQueueNoise()` (below) mitigates
 * leftovers from a previous interrupted run in a serial, single-process
 * execution, but this is NOT proof of isolation from a concurrent test run,
 * another suite, or a real worker invocation touching the same local queue.
 *
 * Skipped automatically when SUPABASE_URL is absent.
 */
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handleScoreWorker } from "../index.ts";
import { scriptedOpenAi, themeScores } from "./fixtures.ts";
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

// Unique per run so leftover rows from an interrupted run are identifiable
// (by name/tag) rather than anonymous, and never collide with a concurrent
// run. `sources.name` is UNIQUE NOT NULL with no length limit; a timestamp
// alone can collide if two runs start within the same millisecond (e.g. two
// parallel CI jobs), so a UUID component is appended for collision resistance.
const runTag = `T-score-${Date.now()}-${crypto.randomUUID()}`;
let sourceId = "";
const rawPostIds: string[] = [];
let evalRequestId = "";
// Requests created ad-hoc by tests that need isolation (their own request they
// can close/pollute without touching the shared evalRequestId). Cleaned in teardown.
const createdRequestIds: string[] = [];

function request(body: unknown, apikey?: string): Request {
  return new Request("https://local.test/score-worker", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apikey ? { apikey } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

const CONFIG_SNAPSHOT = {
  themes: [
    { theme_id: "sustainability", label: "sustainability", position: 1 },
    { theme_id: "innovation", label: "innovation", position: 2 },
    { theme_id: "talent_development", label: "talent development", position: 3 },
    { theme_id: "food_safety", label: "food safety", position: 4 },
    { theme_id: "supply_chain", label: "supply chain", position: 5 },
    { theme_id: "tradition", label: "tradition", position: 6 },
  ],
  min_relevance_score: 50,
};

async function makeRawPost(text: string): Promise<string> {
  const { data, error } = await db
    .from("raw_posts")
    .insert({
      source_id: sourceId,
      source_url: `https://example.test/post-${crypto.randomUUID()}`,
      external_post_id: crypto.randomUUID(),
      post_text: text,
      published_at: new Date().toISOString(),
    })
    .select("id").single();
  if (error) throw error;
  return data.id as string;
}

/**
 * The scoring_jobs queue is shared Postgres state, not per-test-file — a
 * stale message from an earlier interrupted run (or another suite) stays
 * invisible for up to its visibility timeout, but is still "in" the queue.
 * Claiming everything currently visible here, without completing or
 * failing it, keeps it out of every batch read for the rest of this run
 * (VISIBILITY_TIMEOUT_SECONDS is 120s, comfortably longer than the suite).
 */
async function drainAmbientQueueNoise() {
  await db.rpc("read_scoring_jobs", { p_vt: 120, p_qty: 1000 });
}

/**
 * Fails fast, before any row is written, if a schema object this suite
 * depends on is missing — so a migration gap (e.g. running against a
 * database that hasn't picked up 0009/0010 yet) surfaces as one clear error
 * instead of a confusing cascade of downstream RPC/table failures.
 */
async function requireSchema() {
  const { error: rpcErr } = await db.rpc("read_scoring_jobs", { p_vt: 1, p_qty: 0 });
  if (rpcErr) throw new Error(`required RPC public.read_scoring_jobs is missing or broken: ${rpcErr.message}`);

  for (const table of ["scoring_requests", "scoring_job_state", "scoring_dead_letter", "raw_posts", "sources"]) {
    const { error } = await db.from(table).select("*", { head: true, count: "exact" });
    if (error) throw new Error(`required table public.${table} is missing or unreachable: ${error.message}`);
  }

  // 0009/0010 columns this suite exercises directly (processing_token via
  // read_scoring_jobs' return shape, prompt_template via scoring_requests).
  const { error: ptErr } = await db.from("scoring_requests").select("prompt_template", { head: true });
  if (ptErr) throw new Error(`scoring_requests.prompt_template missing (needs migration 0010): ${ptErr.message}`);
}

async function setup() {
  await requireSchema();
  await drainAmbientQueueNoise();
  const { data: src, error: srcErr } = await db
    .from("sources")
    .insert({ name: runTag, source_type: "linkedin", url: "https://example.test", enabled: true })
    .select("id").single();
  if (srcErr) throw srcErr;
  sourceId = src.id as string;

  // An 'evaluation' request, NOT production — raw_posts insert only
  // auto-enqueues under an active PRODUCTION request, so this gives full
  // control over which jobs exist without fighting the trigger.
  const { data: reqId, error: reqErr } = await db.rpc("create_scoring_request", {
    p_purpose: "evaluation",
    p_prompt_version: "scoring_v1",
    p_prompt_hash: "test-hash",
    p_config_snapshot: CONFIG_SNAPSHOT,
    p_model: "gpt-test",
    p_model_snapshot: "gpt-test-2026-01-01",
    p_aggregation_strategy: "max_theme_v1",
  });
  if (reqErr) throw reqErr;
  evalRequestId = reqId as string;
  const { error: actErr } = await db.rpc("activate_scoring_request", { p_request_id: evalRequestId });
  if (actErr) throw actErr;
}

/**
 * Postgres error code for a foreign-key restrict violation. raw_posts that
 * this suite scored for real (happy-path / idempotency / lease tests) get an
 * append-only scoring_results row FK'd to them with ON DELETE RESTRICT, and
 * scoring_results itself blocks UPDATE/DELETE unconditionally (0005's
 * immutability trigger) — so those specific raw_posts (and their source,
 * while still referenced) can never be deleted by any teardown, ever. That is
 * expected and reported, not a leak: the row is tagged (via its source's
 * name) and traceable. Any OTHER delete failure is a real bug and must fail
 * the teardown step loudly rather than being silently discarded.
 */
const FK_RESTRICT_VIOLATION = "23503";

/**
 * What the CANONICAL, tracked migrations (0001-0010, as applied to a clean
 * `db push --local`) actually grant `service_role`: SELECT only on
 * `scoring_job_state` / `scoring_dead_letter` / `scoring_requests` /
 * `scoring_results` — no DELETE, no delete RPC exists for any of them either.
 * This is deliberate (0005: "All writes ... go through the SECURITY DEFINER
 * RPCs; those tables grant SELECT only to service_role"). Teardown must NOT
 * attempt a direct DELETE against these tables — it will always fail with
 * "permission denied", and attempting it anyway is not a defensive check,
 * it's a guaranteed error. (The wider INSERT/UPDATE/DELETE grants observed
 * on the CLOUD project do not trace to any tracked migration file and must
 * not be relied on here — a clean local database, migrated only from the
 * tracked files, is the canonical baseline this harness is written against.)
 *
 * The only mutation teardown performs on these rows is closing the request
 * via `close_scoring_request` (a SECURITY DEFINER RPC service_role IS
 * granted execute on). scoring_job_state / scoring_dead_letter rows for a
 * closed request are permanently retained — not a bug, not something this
 * harness can or should work around — and are reported below, not silently
 * treated as cleaned.
 */
async function teardown() {
  const failures: string[] = [];
  const requestIds = [evalRequestId, ...createdRequestIds].filter(Boolean);

  for (const rid of requestIds) {
    // scoring_job_state / scoring_dead_letter / scoring_results rows for
    // this request are NOT deleted — service_role has no DELETE grant on
    // them under the canonical migrations, and no delete RPC exists. Only
    // close the request, which IS the correct/only intended teardown action.
    const { error: closeErr } = await db.rpc("close_scoring_request", { p_request_id: rid });
    if (closeErr) failures.push(`close_scoring_request(${rid}): ${closeErr.message}`);
  }

  if (rawPostIds.length) {
    const { error: apErr } = await db.from("analyzed_posts").delete().in("raw_post_id", rawPostIds);
    if (apErr) failures.push(`analyzed_posts cleanup: ${apErr.message}`);

    const { error: rpErr } = await db.from("raw_posts").delete().in("id", rawPostIds);
    if (rpErr && rpErr.code !== FK_RESTRICT_VIOLATION) {
      failures.push(`raw_posts cleanup: ${rpErr.message}`);
    }
    // FK_RESTRICT_VIOLATION here is expected and reported below, not a failure.
  }

  if (sourceId) {
    const { error: srcErr } = await db.from("sources").delete().eq("id", sourceId);
    if (srcErr && srcErr.code !== FK_RESTRICT_VIOLATION) {
      failures.push(`sources cleanup: ${srcErr.message}`);
    }
    // FK_RESTRICT_VIOLATION here is expected and reported below, not a failure.
  }

  // Explicit, read-only report of exactly what this run's rows look like
  // after the cleanup attempts above — scoped to this run's own request
  // IDs / raw_post IDs / source ID / runTag throughout, so it can never
  // report another run's rows. This is reporting, not a claim of success:
  // retained audit/history rows are expected under the canonical grants and
  // are never described as "cleaned".
  const retained: string[] = [];

  if (requestIds.length) {
    const { data: reqRows, error: reqErr } = await db
      .from("scoring_requests").select("id, status").in("id", requestIds);
    if (reqErr) failures.push(`retained-scoring_requests query: ${reqErr.message}`);
    else retained.push(`scoring_requests: ${reqRows?.length ?? 0} row(s) retained (closed, not deletable) — ${
      (reqRows ?? []).map((r) => `${r.id}:${r.status}`).join(", ") || "(none)"
    }`);

    const { count: jobCount, error: jobCountErr } = await db
      .from("scoring_job_state").select("*", { count: "exact", head: true }).in("scoring_request_id", requestIds);
    if (jobCountErr) failures.push(`retained-scoring_job_state query: ${jobCountErr.message}`);
    else retained.push(`scoring_job_state: ${jobCount ?? 0} row(s) retained under run tag ${runTag} (service_role has no DELETE grant)`);

    const { count: dlCount, error: dlCountErr } = await db
      .from("scoring_dead_letter").select("*", { count: "exact", head: true }).in("scoring_request_id", requestIds);
    if (dlCountErr) failures.push(`retained-scoring_dead_letter query: ${dlCountErr.message}`);
    else retained.push(`scoring_dead_letter: ${dlCount ?? 0} row(s) retained under run tag ${runTag} (service_role has no DELETE grant)`);

    const { count: resCount, error: resCountErr } = await db
      .from("scoring_results").select("*", { count: "exact", head: true }).in("scoring_request_id", requestIds);
    if (resCountErr) failures.push(`retained-scoring_results query: ${resCountErr.message}`);
    else retained.push(`scoring_results: ${resCount ?? 0} row(s) retained under run tag ${runTag} (append-only by design, 0005 trigger)`);
  }

  if (rawPostIds.length) {
    const { data: rpRows, error: rpCheckErr } = await db.from("raw_posts").select("id").in("id", rawPostIds);
    if (rpCheckErr) failures.push(`retained-raw_posts query: ${rpCheckErr.message}`);
    else retained.push(`raw_posts: ${rpRows?.length ?? 0} of ${rawPostIds.length} row(s) retained under run tag ${runTag} (FK-restrict from scoring_results)`);
  }

  if (sourceId) {
    const { data: srcRows, error: srcCheckErr } = await db.from("sources").select("id").eq("id", sourceId);
    if (srcCheckErr) failures.push(`retained-sources query: ${srcCheckErr.message}`);
    else retained.push(`sources: ${srcRows?.length ?? 0} row(s) retained under run tag ${runTag} (${srcRows?.length ? "still referenced by scored raw_posts" : "deleted"})`);
  }

  if (retained.length) {
    console.warn(`[score-worker teardown] retained-row report for run tag ${runTag}:\n  - ${retained.join("\n  - ")}`);
  }

  if (failures.length) {
    throw new Error(`teardown hit unexpected errors:\n  - ${failures.join("\n  - ")}`);
  }
}

async function enqueue(text: string): Promise<{ rawPostId: string; jobId: string }> {
  return await enqueueUnder(evalRequestId, text);
}

async function enqueueUnder(requestId: string, text: string): Promise<{ rawPostId: string; jobId: string }> {
  const rawPostId = await makeRawPost(text);
  rawPostIds.push(rawPostId);
  const { data: jobId, error } = await db.rpc("enqueue_scoring_job", {
    p_raw_post_id: rawPostId, p_scoring_request_id: requestId,
  });
  if (error) throw error;
  return { rawPostId, jobId: jobId as string };
}

/** Create + activate a fresh evaluation request, tracked for teardown. An
 * optional custom prompt template proves the worker renders from the request
 * row (blocker #3) rather than a hardcoded constant. */
async function makeEvalRequest(promptTemplate?: string): Promise<string> {
  const { data: reqId, error } = await db.rpc("create_scoring_request", {
    p_purpose: "evaluation",
    p_prompt_version: "scoring_v1",
    p_prompt_hash: "test-hash",
    p_config_snapshot: CONFIG_SNAPSHOT,
    p_model: "gpt-test",
    p_model_snapshot: "gpt-test-2026-01-01",
    p_aggregation_strategy: "max_theme_v1",
    ...(promptTemplate ? { p_prompt_template: promptTemplate } : {}),
  });
  if (error) throw error;
  createdRequestIds.push(reqId as string);
  const { error: actErr } = await db.rpc("activate_scoring_request", { p_request_id: reqId });
  if (actErr) throw actErr;
  return reqId as string;
}

/**
 * One parent test owns setup/steps/teardown so teardown runs from a real
 * `finally`, not a separately-registered `Deno.test` that merely happens to
 * be declared after the others.
 *
 * IMPORTANT Deno behavior this relies on: `await t.step(...)` does NOT throw
 * or reject when the step's callback throws — it catches internally, reports
 * the step as failed, and resolves to `false`. A naive
 * `try { await t.step(...); await t.step(...) } finally { ... }` would NOT
 * stop at the first failing step — every subsequent step would still
 * execute, because there is nothing to unwind. `runStep` below makes failure
 * explicit: it captures the boolean, and once any step has failed it skips
 * (does not execute) every later step in the sequence, while still letting
 * the `finally` run teardown.
 *
 * This protects against a failed *step* leaving teardown unrun under normal
 * in-process execution. It does NOT protect against the *process* being
 * killed (an outer Docker/shell timeout, Ctrl-C, OOM) or a module-load
 * failure before this test registers — nothing inside the process runs after
 * that, teardown included; only an outer process-level timeout bounds that.
 */
Deno.test({
  name: "[score-worker] whole flow",
  ignore: !LIVE,
  async fn(t) {
    let sawFailure = false;
    async function runStep(name: string, fn: () => Promise<void>) {
      if (sawFailure) return; // a prior step already failed; skip the rest
      const ok = await t.step(name, fn);
      if (!ok) sawFailure = true;
    }

    const setupOk = await t.step("000 setup", setup);
    if (!setupOk) sawFailure = true;

    try {
      if (sawFailure) return; // setup itself failed; nothing else can run meaningfully

      // =====================================================================
      // AUTHORISATION — no editor path; internal secret only
      // =====================================================================
      await runStep("no credentials -> 401", async () => {
        const res = await handleScoreWorker(request({}), { db });
        assertEquals(res.status, 401);
      });

      await runStep("wrong internal secret -> 401", async () => {
        const res = await handleScoreWorker(request({}, "not-the-secret"), { db });
        assertEquals(res.status, 401);
      });

      // =====================================================================
      // REQUEST VALIDATION
      // =====================================================================
      await runStep("batch_size out of range -> 400", async () => {
        const res = await handleScoreWorker(request({ batch_size: 0 }, INTERNAL_SECRET), { db });
        assertEquals(res.status, 400);
      });

      await runStep("no jobs queued -> ok with zero totals", async () => {
        // Drain whatever is already visible so this assertion is not flaky
        // against leftovers from a previous run in the same request.
        // `totals.*` is process-wide-queue-scoped, not request-scoped — see
        // the shared-state limitation documented at the top of this file.
        await handleScoreWorker(request({ batch_size: 25 }, INTERNAL_SECRET), {
          db, ...scriptedOpenAi([{ result: { theme_scores: themeScores(), reason: "drain" } }]),
        });
        const { callOpenAiImpl, calls } = scriptedOpenAi([]);
        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.totals.jobs_read, 0);
        assertEquals(calls.length, 0);
      });

      // =====================================================================
      // HAPPY PATH
      // =====================================================================
      await runStep("scores a job end to end and writes an llm_verified scoring_result", async () => {
        const { rawPostId, jobId } = await enqueue("A great post about sustainable food supply chains.");
        const { callOpenAiImpl, calls } = scriptedOpenAi([
          { result: { theme_scores: themeScores({ sustainability: 85, supply_chain: 70 }), reason: "Strong sustainability angle." } },
        ]);

        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.totals.scored, 1);
        assertEquals(calls.length, 1);
        assertEquals(calls[0].model, "gpt-test-2026-01-01", "uses the request's pinned model_snapshot, never a hardcoded one");

        const { data: job } = await db.from("scoring_job_state").select("status").eq("id", jobId).single();
        assertEquals(job!.status, "succeeded");

        const { data: result } = await db
          .from("scoring_results").select("*").eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId).single();
        assertEquals(result!.source, "openai");
        assertEquals(result!.provenance_status, "llm_verified");
        assertEquals(result!.llm_used, true);
        assertEquals(result!.overall_relevance, 85);
        assertEquals(result!.theme_scores.sustainability, 85);
      });

      await runStep("a second read of the same message range does not double-score", async () => {
        const { rawPostId } = await enqueue("Another editorial-relevant post about innovation.");
        const { callOpenAiImpl } = scriptedOpenAi([
          { result: { theme_scores: themeScores({ innovation: 60 }), reason: "innovation angle" } },
        ]);
        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.scored, 1);

        const { count } = await db
          .from("scoring_results").select("*", { count: "exact", head: true })
          .eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId);
        assertEquals(count, 1);
      });

      // =====================================================================
      // FAILURE HANDLING — no silent fallback, ever
      // =====================================================================
      await runStep("a refusal dead-letters immediately, never as a fabricated score", async () => {
        const { jobId, rawPostId } = await enqueue("Some post that gets refused.");
        const { callOpenAiImpl } = scriptedOpenAi([{ throws: "refusal" }]);

        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.dead_lettered, 1);
        assertEquals(body.results[0].error_code, "refusal");

        const { data: job } = await db.from("scoring_job_state").select("status, failure_count, last_failure_type").eq("id", jobId).single();
        assertEquals(job!.status, "dead_letter", "retrying asks the model the same question and gets the same refusal");
        assertEquals(job!.failure_count, 1);
        assertEquals(job!.last_failure_type, "refusal");

        const { count } = await db
          .from("scoring_results").select("*", { count: "exact", head: true })
          .eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId);
        assertEquals(count, 0);
      });

      await runStep("three consecutive failures dead-letter the job", async () => {
        // record_scoring_failure sets a real, server-authoritative pgmq
        // visibility timeout after each retry (30s, then 120s) so the SAME
        // message cannot be reclaimed from the queue a second time inside a
        // fast test run — pgmq.read only ever returns messages whose vt has
        // already passed, and there is no supported way to force an earlier
        // one visible without weakening the backoff itself. The first
        // attempt goes through the real worker (proving it wires an OpenAI
        // failure into record_scoring_failure correctly); the 2nd and 3rd
        // attempts call record_scoring_failure directly with the same
        // msg_id, which is exactly what the worker itself would do on read —
        // the thing under test here is the RPC's own 3-strikes threshold,
        // not pgmq timing, and the RPC never re-checks pgmq visibility itself.
        const { jobId, rawPostId } = await enqueue("A post that always fails.");

        const { callOpenAiImpl } = scriptedOpenAi([{ throws: "server_error" }]);
        await handleScoreWorker(request({ batch_size: 25 }, INTERNAL_SECRET), { db, callOpenAiImpl });

        const { data: afterFirst } = await db.from("scoring_job_state").select("msg_id, scoring_request_id").eq("id", jobId).single();
        assert(afterFirst!.msg_id, "the message id persists across retries so later attempts can still reference it");

        for (let attempt = 2; attempt <= 3; attempt++) {
          const { error } = await db.rpc("record_scoring_failure", {
            p_job_id: jobId, p_msg_id: afterFirst!.msg_id, p_raw_post_id: rawPostId,
            p_scoring_request_id: afterFirst!.scoring_request_id,
            p_failure_type: "server_error", p_error_code: null, p_error_message: "boom",
          });
          if (error) throw error;
        }

        const { data: job } = await db.from("scoring_job_state").select("status").eq("id", jobId).single();
        assertEquals(job!.status, "dead_letter");

        const { data: dl } = await db.from("scoring_dead_letter").select("*").eq("job_id", jobId).single();
        assert(dl);
        assertEquals(dl!.attempts, 3);

        const { count } = await db
          .from("scoring_results").select("*", { count: "exact", head: true })
          .eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId);
        assertEquals(count, 0, "a dead-lettered job never produces a fabricated result");
      });

      await runStep("a content_filter failure dead-letters immediately, without 3 retries", async () => {
        const { jobId, rawPostId } = await enqueue("A post that trips the content filter.");
        const { callOpenAiImpl } = scriptedOpenAi([{ throws: "content_filter" }]);

        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.dead_lettered, 1);
        assertEquals(body.results[0].status, "dead_letter");

        const { data: job } = await db.from("scoring_job_state").select("status, failure_count, last_failure_type").eq("id", jobId).single();
        assertEquals(job!.status, "dead_letter");
        assertEquals(job!.failure_count, 1, "dead-lettered on the first occurrence, not after 3 strikes");
        assertEquals(job!.last_failure_type, "content_filter");

        const { data: dl } = await db.from("scoring_dead_letter").select("failure_type, attempts").eq("job_id", jobId).single();
        assertEquals(dl!.failure_type, "content_filter", "the real reason is preserved, not overwritten with 'exhausted'");
        assertEquals(dl!.attempts, 1);

        const { count } = await db
          .from("scoring_results").select("*", { count: "exact", head: true })
          .eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId);
        assertEquals(count, 0);
      });

      await runStep("one job's failure does not abort the batch", async () => {
        const failing = await enqueue("This one fails.");
        const succeeding = await enqueue("This one succeeds fine.");

        let call = 0;
        const callOpenAiImpl = (async () => {
          call++;
          if (call === 1) throw new OpenAiError("timeout", "scripted timeout");
          return { parsed: { theme_scores: themeScores({ innovation: 55 }), reason: "ok" }, raw: {} };
        }) as typeof import("../../_shared/openai.ts").callOpenAi;

        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.jobs_read, 2);
        assertEquals(body.totals.scored, 1);
        assertEquals(body.totals.retried, 1);

        const { data: okResult } = await db
          .from("scoring_results").select("*").eq("raw_post_id", succeeding.rawPostId).eq("scoring_request_id", evalRequestId).maybeSingle();
        assert(okResult, "the second job still completed despite the first failing");

        const { data: failedJob } = await db.from("scoring_job_state").select("status").eq("id", failing.jobId).single();
        assertEquals(failedJob!.status, "pending", "left retryable, not silently dropped");
      });

      await runStep("model_snapshot comes from the request, never overridable by the body", async () => {
        const { callOpenAiImpl, calls } = scriptedOpenAi([
          { result: { theme_scores: themeScores(), reason: "n/a" } },
        ]);
        await enqueue("Model override attempt post.");
        await handleScoreWorker(
          request({ batch_size: 1, model: "attacker-supplied-model" }, INTERNAL_SECRET),
          { db, callOpenAiImpl },
        );
        assertEquals(calls[0]?.model, "gpt-test-2026-01-01");
      });

      // =====================================================================
      // LEASE / OWNERSHIP — blockers #1 + #2 (processing_token)
      // =====================================================================
      await runStep("only the current lease holder can complete; a stale token is superseded", async () => {
        await drainAmbientQueueNoise();                       // isolate: nothing else visible
        const { rawPostId, jobId } = await enqueue("Lease test post.");

        // Claim it the way the worker does — read_scoring_jobs stamps a fresh token.
        const { data: claimed } = await db.rpc("read_scoring_jobs", { p_vt: 120, p_qty: 50 });
        const mine = (claimed as { msg_id: number; message: { job_id: string }; processing_token: string }[])
          .find((m) => m.message.job_id === jobId)!;
        assert(mine?.processing_token, "the claim stamped a processing_token");

        const args = {
          p_job_id: jobId, p_msg_id: mine.msg_id, p_raw_post_id: rawPostId,
          p_scoring_request_id: evalRequestId, p_theme_scores: themeScores({ innovation: 40 }), p_reason: "r",
        };

        // A worker holding a stale (wrong) token must be rejected, benignly.
        const { data: stale } = await db.rpc("complete_scoring_job", { ...args, p_processing_token: crypto.randomUUID() });
        assertEquals(stale, "superseded");

        const { count: after } = await db
          .from("scoring_results").select("*", { count: "exact", head: true })
          .eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId);
        assertEquals(after, 0, "a superseded completion writes nothing");
        const { data: jobMid } = await db.from("scoring_job_state").select("status, failure_count").eq("id", jobId).single();
        assertEquals(jobMid!.status, "processing", "still leased, untouched");
        assertEquals(jobMid!.failure_count, 0, "a superseded worker never burns a retry");

        // The genuine lease holder completes normally.
        const { data: ok } = await db.rpc("complete_scoring_job", { ...args, p_processing_token: mine.processing_token });
        assertEquals(ok, "inserted");
      });

      await runStep("a stale token cannot burn a business retry via record_scoring_failure", async () => {
        await drainAmbientQueueNoise();
        const { rawPostId, jobId } = await enqueue("Lease failure test post.");
        const { data: claimed } = await db.rpc("read_scoring_jobs", { p_vt: 120, p_qty: 50 });
        const mine = (claimed as { msg_id: number; message: { job_id: string } }[]).find((m) => m.message.job_id === jobId)!;

        const { data: superseded } = await db.rpc("record_scoring_failure", {
          p_job_id: jobId, p_msg_id: mine.msg_id, p_raw_post_id: rawPostId, p_scoring_request_id: evalRequestId,
          p_failure_type: "server_error", p_error_code: "500", p_error_message: "stale worker",
          p_processing_token: crypto.randomUUID(),
        });
        assertEquals(superseded, "superseded");
        const { data: job } = await db.from("scoring_job_state").select("status, failure_count").eq("id", jobId).single();
        assertEquals(job!.failure_count, 0, "a superseded failure is not counted");
        assertEquals(job!.status, "processing");
      });

      // =====================================================================
      // INFRA vs BUSINESS FAILURE — blocker #5
      // =====================================================================
      await runStep("a DB-completion failure is infrastructure, not a burned retry", async () => {
        await drainAmbientQueueNoise();
        const { rawPostId, jobId } = await enqueue("Infra-failure test post.");
        const { callOpenAiImpl } = scriptedOpenAi([
          { result: { theme_scores: themeScores({ innovation: 60 }), reason: "ok" } },
        ]);

        // A db whose complete_scoring_job always errors — the OpenAI call still
        // succeeds, so this simulates a fault AFTER the paid work is done.
        const failingDb = {
          from: db.from.bind(db),
          rpc: (name: string, params?: unknown) =>
            name === "complete_scoring_job"
              ? Promise.resolve({ data: null, error: { message: "simulated DB outage" } })
              : (db.rpc as (n: string, p?: unknown) => unknown)(name, params),
        } as unknown as SupabaseClient;

        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db: failingDb, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.infra_error, 1);
        assertEquals(body.totals.scored, 0);

        const { data: job } = await db.from("scoring_job_state").select("status, failure_count").eq("id", jobId).single();
        assertEquals(job!.failure_count, 0, "an infra fault must not consume a business retry");
        assertEquals(job!.status, "processing", "job stays leased so its message is re-claimed after the VT");

        const { count } = await db
          .from("scoring_results").select("*", { count: "exact", head: true })
          .eq("raw_post_id", rawPostId).eq("scoring_request_id", evalRequestId);
        assertEquals(count, 0);
      });

      // =====================================================================
      // PROMPT SNAPSHOT — blocker #3 (prompt comes from the request row)
      // =====================================================================
      await runStep("renders the prompt from the request's stored template, not a code constant", async () => {
        await drainAmbientQueueNoise();
        const marker = `MARKER-${crypto.randomUUID()}`;
        const customReq = await makeEvalRequest(`${marker}\nThemes:\n{{THEMES}}\n\nSOURCE={{SOURCE}} ID={{POST_ID}}\n\n{{POST_TEXT}}`);
        await enqueueUnder(customReq, "distinctive body text ABC123");

        const { callOpenAiImpl, calls } = scriptedOpenAi([{ result: { theme_scores: themeScores(), reason: "ok" } }]);
        const res = await handleScoreWorker(request({ batch_size: 5 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        assertEquals((await res.json()).totals.scored, 1);

        assert(calls[0].input.includes(marker), "prompt uses the request's stored template text");
        assert(calls[0].input.includes("distinctive body text ABC123"), "{{POST_TEXT}} interpolated");
        assert(calls[0].input.includes("- innovation (innovation)"), "{{THEMES}} interpolated from the snapshot");
      });

      // This test uses its OWN request (it closes it as the circuit-break under
      // test), so it no longer has to run last — the shared evalRequestId is
      // unaffected regardless of ordering (blocker #7).
      await runStep("an auth error dead-letters the job and closes the request (circuit-break)", async () => {
        await drainAmbientQueueNoise();
        const cbReq = await makeEvalRequest();
        const { jobId: failingJobId } = await enqueueUnder(cbReq, "First job under a doomed request.");
        const { jobId: siblingJobId } = await enqueueUnder(cbReq, "Second job, never gets read this batch.");
        const { callOpenAiImpl } = scriptedOpenAi([{ throws: "client_error", httpStatus: 401 }]);

        const res = await handleScoreWorker(request({ batch_size: 1 }, INTERNAL_SECRET), { db, callOpenAiImpl });
        const body = await res.json();
        assertEquals(body.totals.dead_lettered, 1);

        const { data: failingJob } = await db.from("scoring_job_state").select("status").eq("id", failingJobId).single();
        assertEquals(failingJob!.status, "dead_letter");

        const { data: req } = await db.from("scoring_requests").select("status").eq("id", cbReq).single();
        assertEquals(req!.status, "closed", "every other job under this request would fail identically, so draining stops");

        // The sibling wasn't read this batch (batch_size 1) but its request is
        // now closed, which is what stops trg_enqueue_scoring_on_raw_post
        // feeding it more NEW jobs. KNOWN GAP (see file header / reconciliation
        // notes): a job that was already claimable BEFORE the close — like this
        // sibling — is not itself blocked from being claimed and sent to OpenAI
        // by a later read_scoring_jobs call; nothing in read_scoring_jobs joins
        // to scoring_requests.status. This assertion only proves the sibling
        // wasn't read in THIS batch (batch_size 1), not that a later batch
        // couldn't still claim and pay to score it.
        const { data: siblingJob } = await db.from("scoring_job_state").select("status").eq("id", siblingJobId).single();
        assertEquals(siblingJob!.status, "pending");
      });
    } finally {
      await t.step("zzz teardown", teardown);
    }
  },
});

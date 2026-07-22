/**
 * Whole-flow tests for the ingest handler against the LOCAL Supabase stack.
 *
 * The provider is always a scripted fetch. Nothing here calls RapidAPI, and
 * RAPIDAPI_KEY is set to a dummy value precisely so a real call would fail
 * loudly rather than quietly succeed.
 *
 * Run (from the repo root):
 *   docker run --rm --network supabase_network_cues-editorial-cloud \
 *     -v "$PWD/supabase/functions:/app" -w /app \
 *     -e SUPABASE_URL=http://kong:8000 -e SUPABASE_ANON_KEY=... \
 *     -e SUPABASE_SERVICE_ROLE_KEY=... -e RAPIDAPI_KEY=dummy-not-used \
 *     denoland/deno:alpine-2.5.2 deno test --allow-env --allow-net ingest/__tests__/
 *
 * Skipped automatically when SUPABASE_URL is absent, so the pure unit suite
 * still runs standalone.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { handleIngest } from "../index.ts";
import { daysAgo, noSleep, post, scriptedFetch } from "./fixtures.ts";

const URL_ = Deno.env.get("SUPABASE_URL");
const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const LIVE = Boolean(URL_ && ANON && SERVICE);

const it = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name: `[handler] ${name}`, ignore: !LIVE, fn });

const db: SupabaseClient = LIVE
  ? createClient(URL_!, SERVICE!, { auth: { persistSession: false } })
  : (null as unknown as SupabaseClient);

const PW = "test-password-123!";
const stamp = Date.now();
const emails = {
  admin: `admin.${stamp}@cues.test`,
  editor: `editor.${stamp}@cues.test`,
  outsider: `outsider.${stamp}@cues.test`,
};
const tokens: Record<string, string> = {};
let sourceA = "";
let sourceB = "";
let disabledSource = "";
let noIdentSource = "";

async function makeUser(email: string, role: "admin" | "editor" | null) {
  const { data, error } = await db.auth.admin.createUser({
    email, password: PW, email_confirm: true,
  });
  if (error) throw error;
  if (role) {
    const { error: e2 } = await db.from("editors").insert({ user_id: data.user!.id, email, role });
    if (e2) throw e2;
  }
  const anonClient = createClient(URL_!, ANON!, { auth: { persistSession: false } });
  const { data: session, error: e3 } = await anonClient.auth.signInWithPassword({ email, password: PW });
  if (e3) throw e3;
  tokens[email] = session.session!.access_token;
  return data.user!.id;
}

async function setup() {
  await makeUser(emails.admin, "admin");
  await makeUser(emails.editor, "editor");
  await makeUser(emails.outsider, null);

  const mk = async (name: string, enabled: boolean, ident: string | null) => {
    const { data, error } = await db
      .from("sources")
      .insert({ name, source_type: "linkedin", url: "https://example.test", enabled, rapidapi_identifier: ident })
      .select("id").single();
    if (error) throw error;
    return data.id as string;
  };
  sourceA = await mk(`T-A-${stamp}`, true, "https://www.linkedin.com/company/a");
  sourceB = await mk(`T-B-${stamp}`, true, "https://www.linkedin.com/company/b");
  disabledSource = await mk(`T-disabled-${stamp}`, false, "https://www.linkedin.com/company/c");
  noIdentSource = await mk(`T-noident-${stamp}`, true, null);
}

async function teardown() {
  for (const id of [sourceA, sourceB, disabledSource, noIdentSource].filter(Boolean)) {
    await db.from("raw_posts").delete().eq("source_id", id);
    await db.from("ingest_run_sources").delete().eq("source_id", id);
    await db.from("sources").delete().eq("id", id);
  }
  const { data: users } = await db.auth.admin.listUsers();
  for (const u of users?.users ?? []) {
    if (u.email && Object.values(emails).includes(u.email)) {
      await db.auth.admin.deleteUser(u.id);
    }
  }
}

function request(body: unknown, token?: string): Request {
  return new Request("https://local.test/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

const runCount = async (): Promise<number> => {
  const { count } = await db.from("ingest_runs").select("*", { count: "exact", head: true });
  return count ?? 0;
};

if (LIVE) {
  Deno.test({ name: "[handler] 000 setup", fn: setup, sanitizeOps: false, sanitizeResources: false });
}

// ===========================================================================
// AUTHORISATION — none of these may create a run row
// ===========================================================================
it("no JWT -> 401 and no run row", async () => {
  const before = await runCount();
  const res = await handleIngest(request({ source_ids: [sourceA] }), { db });
  assertEquals(res.status, 401);
  assertEquals(await runCount(), before);
});

it("authenticated non-editor -> 403 and no run row", async () => {
  const before = await runCount();
  const res = await handleIngest(request({ source_ids: [sourceA] }, tokens[emails.outsider]), { db });
  assertEquals(res.status, 403);
  assertEquals(await runCount(), before);
});

it("editor but not admin -> 403 and no run row", async () => {
  // Every invocation costs metered quota, so collection is admin-only until
  // real usage has been measured.
  const before = await runCount();
  const res = await handleIngest(request({ source_ids: [sourceA] }, tokens[emails.editor]), { db });
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.includes("admin"), true);
  assertEquals(await runCount(), before);
});

it("admin -> allowed, recorded as manual with the actor snapshot", async () => {
  const { fetchImpl } = scriptedFetch([{ body: [] }]);
  const res = await handleIngest(
    request({ source_ids: [sourceA] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.totals.trigger_source, "manual");
  assertEquals(body.totals.triggered_by_email, emails.admin);
  assert(body.totals.triggered_by !== null);
});

it("service role -> cron path, no user attributed", async () => {
  const { fetchImpl } = scriptedFetch([{ body: [] }]);
  const res = await handleIngest(
    request({ source_ids: [sourceA] }, SERVICE!),
    { db, fetchImpl, sleep: noSleep },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.totals.trigger_source, "cron");
  assertEquals(body.totals.triggered_by, null);
});

it("browser-supplied trigger_source is ignored", async () => {
  const { fetchImpl } = scriptedFetch([{ body: [] }]);
  const res = await handleIngest(
    request({ source_ids: [sourceA], trigger_source: "cron" }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  const body = await res.json();
  assertEquals(body.totals.trigger_source, "manual", "an editor cannot claim to be cron");
});

// ===========================================================================
// REQUEST VALIDATION
// ===========================================================================
it("unknown source id -> 400 and no run row", async () => {
  const before = await runCount();
  const res = await handleIngest(
    request({ source_ids: ["99999999-9999-4999-8999-999999999999"] }, tokens[emails.admin]),
    { db },
  );
  assertEquals(res.status, 400);
  assertEquals(await runCount(), before);
});

// ===========================================================================
// SKIPS COST NO QUOTA
// ===========================================================================
it("disabled and identifier-less sources are skipped with zero provider attempts", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: [] }]);
  const res = await handleIngest(
    request({ source_ids: [disabledSource, noIdentSource] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  const body = await res.json();
  assertEquals(calls.length, 0, "no HTTP call is made for a source we never intended to fetch");
  assertEquals(body.totals.provider_requests, 0);
  const codes = body.results.map((r: Record<string, string>) => r.error_code).sort();
  assertEquals(codes, ["disabled", "no_rapidapi_identifier"]);
});

// ===========================================================================
// DRY RUN — calls the provider, writes no posts
// ===========================================================================
it("dry_run records the run but writes no raw_posts", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { body: [post("7900000000000000001", "dry run body", daysAgo(1))] },
    { body: [] },
  ]);
  const res = await handleIngest(
    request({ source_ids: [sourceA], dry_run: true }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  const body = await res.json();
  assert(calls.length > 0, "dry_run still spends provider quota");
  assertEquals(body.totals.dry_run, true);
  assertEquals(body.totals.posts_inserted, 0);
  const { count } = await db.from("raw_posts").select("*", { count: "exact", head: true }).eq("source_id", sourceA);
  assertEquals(count ?? 0, 0, "nothing was written");
});

// ===========================================================================
// REAL COLLECTION AND COUNTER FIDELITY
// ===========================================================================
it("collects, then a second run inserts nothing", async () => {
  const page = [
    post("7900000000000000010", "first", daysAgo(1)),
    post("7900000000000000011", "second", daysAgo(2)),
  ];
  const first = await handleIngest(
    request({ source_ids: [sourceA] }, tokens[emails.admin]),
    { db, ...scriptedFetch([{ body: page }, { body: [] }]), sleep: noSleep },
  );
  const b1 = await first.json();
  assertEquals(b1.totals.posts_inserted, 2);

  const second = await handleIngest(
    request({ source_ids: [sourceA] }, tokens[emails.admin]),
    { db, ...scriptedFetch([{ body: page }, { body: [] }]), sleep: noSleep },
  );
  const b2 = await second.json();
  assertEquals(b2.totals.posts_inserted, 0, "idempotent");
  assertEquals(b2.totals.posts_metadata_refreshed, 2);
});

it("persisted counters match the HTTP response exactly", async () => {
  const { fetchImpl } = scriptedFetch([
    {
      body: [
        post("7900000000000000020", "kept", daysAgo(1)),
        { text: "no id", postedAt: daysAgo(1) },
        { urn: "urn:li:activity:7900000000000000021", text: "", postedAt: daysAgo(1) },
        post("7900000000000000022", "too old", daysAgo(400)),
      ],
    },
    { body: [] },
  ]);
  const res = await handleIngest(
    request({ source_ids: [sourceB] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  const body = await res.json();
  const { data: row } = await db
    .from("ingest_run_sources").select("*").eq("run_id", body.run_id).eq("source_id", sourceB).single();

  for (
    const k of [
      "provider_requests", "pages_fetched", "posts_fetched", "posts_inserted",
      "posts_skipped_no_id", "posts_skipped_malformed", "posts_skipped_out_of_window",
      "posts_metadata_refreshed", "posts_content_changed", "posts_skipped_duplicate",
    ]
  ) {
    assertEquals(row[k], body.results[0][k], `persisted ${k} matches response`);
    assertEquals(row[k], body.totals[k], `run total ${k} matches source row`);
  }
  assertEquals(row.posts_skipped_no_id, 1);
  assertEquals(row.posts_skipped_malformed, 1);
  assertEquals(row.posts_skipped_out_of_window, 1);
});

// ===========================================================================
// FAILURE HANDLING
// ===========================================================================
it("provider 401 stops the run; later sources are not fetched", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 401 }]);
  const res = await handleIngest(
    request({ source_ids: [sourceA, sourceB] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  const body = await res.json();
  assertEquals(calls.length, 1, "one attempt total, not one per source");
  assertEquals(body.status, "failed");
  assertEquals(body.results.length, 1, "the second source was never attempted");
  assertEquals(body.results[0].error_code, "auth");
  assertEquals(body.totals.provider_requests, 1, "a 401 costs exactly one request");
});

it("mixed success and failure -> completed_with_errors", async () => {
  let call = 0;
  const fetchImpl = ((input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : (input as Request).url ?? String(input);
    // linkedin_url is percent-encoded into the query string, so the identifier
    // only appears as %2Fcompany%2Fa unless it is decoded first.
    const url = decodeURIComponent(raw);
    call++;
    // First source succeeds and then terminates with an empty page; the second
    // fails with a server error on every attempt.
    if (url.includes("/company/a")) {
      return Promise.resolve(
        new Response(JSON.stringify(call === 1 ? [post("7900000000000000030", "ok", daysAgo(1))] : []), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("boom", { status: 500 }));
  }) as typeof fetch;

  const res = await handleIngest(
    request({ source_ids: [sourceA, sourceB] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep },
  );
  const body = await res.json();
  assertEquals(body.status, "completed_with_errors");
  assertEquals(body.totals.sources_ok, 1);
  assertEquals(body.totals.sources_failed, 1);
});

// ===========================================================================
// EXECUTION BUDGET
// ===========================================================================
it("budget exhausted before the first source -> failed, budget_exhausted persisted", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: [] }]);
  const res = await handleIngest(
    request({ source_ids: [sourceA, sourceB] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep, deadline: Date.now() - 1 },
  );
  const body = await res.json();
  assertEquals(calls.length, 0, "no quota spent");
  assertEquals(body.status, "failed", "nothing succeeded, so the run failed");

  const { data: rows } = await db.from("ingest_run_sources").select("status, error_code").eq("run_id", body.run_id);
  for (const r of rows ?? []) {
    assertEquals(r.error_code, "budget_exhausted", "the real reason, not 'locked'");
    assertEquals(r.status, "skipped");
  }
  assertEquals(body.totals.sources_failed, 2, "budget-skipped sources count as failures");
});

it("budget exhausted between two sources -> completed_with_errors", async () => {
  // Deterministic rather than timing-tolerant: source A's single fetch sleeps
  // well past the deadline, so A always completes and B is always dropped.
  // A returns an empty page, which stops pagination immediately and means the
  // deadline is only ever checked once for A, before it has expired.
  // The deadline is fixed before the handler authenticates, reaps and queries
  // sources, so the budget must comfortably exceed that setup latency or the
  // FIRST source gets dropped too and the run is legitimately 'failed'.
  // Generous margins keep this deterministic under load.
  const BUDGET_MS = 3_000;
  const A_DELAY_MS = 4_000;

  const fetchImpl = ((input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : (input as Request).url ?? String(input);
    const isA = decodeURIComponent(raw).includes("/company/a");
    return new Promise<Response>((resolve) =>
      setTimeout(
        () => resolve(new Response("[]", { status: 200 })),
        isA ? A_DELAY_MS : 0,
      )
    );
  }) as typeof fetch;

  const res = await handleIngest(
    request({ source_ids: [sourceA, sourceB] }, tokens[emails.admin]),
    { db, fetchImpl, sleep: noSleep, deadline: Date.now() + BUDGET_MS },
  );
  const body = await res.json();

  assertEquals(body.status, "completed_with_errors", "one source done, one dropped");
  assertEquals(body.totals.sources_ok, 1);
  assertEquals(body.totals.sources_failed, 1, "the dropped source counts as a failure");

  const dropped = body.results.find((r: Record<string, string>) => r.error_code === "budget_exhausted");
  assert(dropped, "the second source records budget_exhausted");
  const { data: row } = await db
    .from("ingest_run_sources").select("status, error_code")
    .eq("run_id", body.run_id).eq("source_id", sourceB).single();
  assert(row, "a row was persisted for the dropped source");
  assertEquals(row.error_code, "budget_exhausted", "persisted, not 'locked'");
  assertEquals(row.status, "skipped");
});

if (LIVE) {
  Deno.test({ name: "[handler] zzz teardown", fn: teardown, sanitizeOps: false, sanitizeResources: false });
}

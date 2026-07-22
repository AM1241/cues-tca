import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { collectCompanyPosts, fetchPage, MAX_PAGES } from "../provider.ts";
import { ProviderError } from "../../_shared/errors.ts";
import { daysAgo, noSleep, post, scriptedFetch } from "./fixtures.ts";

const URL_ = "https://www.linkedin.com/company/masaf";
const opts = (fetchImpl: typeof fetch) => ({ apiKey: "test-key", fetchImpl, sleep: noSleep });

// ===========================================================================
// QUOTA ACCOUNTING
// provider_requests counts every outbound attempt; pages_fetched counts only
// pages actually received. These must be able to differ.
// ===========================================================================
Deno.test("quota: two 500s then a page -> 3 attempts, 1 page", async () => {
  // The spec case, asserted where it belongs: one page costing three attempts.
  const { fetchImpl, calls } = scriptedFetch([
    { status: 500, body: "boom" },
    { status: 500, body: "boom" },
    { body: [post("7473335599555338240", "a", daysAgo(1))] },
  ]);
  const { page, attempts } = await fetchPage(URL_, 0, { apiKey: "k", fetchImpl, sleep: noSleep });

  assertEquals(calls.length, 3, "three outbound HTTP attempts were made");
  assertEquals(attempts, 3, "provider_requests contribution");
  assertEquals(page.posts.length, 1, "pages_fetched contribution");
});

Deno.test("quota: retries roll up into the collected total", async () => {
  // Same failures, seen through collectCompanyPosts. The trailing empty page is
  // what stops pagination, and it costs an attempt of its own: 3 + 1 = 4.
  const { fetchImpl, calls } = scriptedFetch([
    { status: 500, body: "boom" },
    { status: 500, body: "boom" },
    { body: [post("7473335599555338240", "a", daysAgo(1))] },
    { body: [] },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));

  assertEquals(r.pagesFetched, 1, "only one page actually arrived");
  assertEquals(r.providerRequests, 4, "every attempt counts, including the empty probe");
  assertEquals(r.providerRequests, calls.length);
  assert(r.providerRequests > r.pagesFetched, "attempts exceed pages when retries happen");
});

// The number the run recorder ultimately persists, per failure class. These
// must be the attempts actually made, never MAX_ATTEMPTS: overstating a 401 as
// three requests would corrupt the very measurement the cadence decision rests
// on.
Deno.test("quota: attempts recorded per failure class", async () => {
  const cases: Array<{ name: string; script: Parameters<typeof scriptedFetch>[0]; expected: number; code: string }> = [
    { name: "401", script: [{ status: 401 }], expected: 1, code: "auth" },
    { name: "403", script: [{ status: 403 }], expected: 1, code: "auth" },
    { name: "429", script: [{ status: 429, headers: { "Retry-After": "30" } }], expected: 1, code: "rate_limit" },
    { name: "malformed 200", script: [{ body: "<html>" }], expected: 1, code: "malformed_response" },
    { name: "500 x3", script: [{ status: 500 }, { status: 500 }, { status: 500 }], expected: 3, code: "server_error" },
    { name: "timeout x3", script: [{ hang: true }], expected: 3, code: "timeout" },
    { name: "network x3", script: [{ throws: "network" }], expected: 3, code: "network" },
  ];

  for (const c of cases) {
    const { fetchImpl, calls } = scriptedFetch(c.script);
    const err = await assertRejects(
      () => collectCompanyPosts(URL_, 30, opts(fetchImpl)),
      ProviderError,
    );
    assertEquals(err.code, c.code, `${c.name}: error code`);
    assertEquals(calls.length, c.expected, `${c.name}: real HTTP attempts`);
    assertEquals(err.attempts, c.expected, `${c.name}: attempts on the error`);
    // What index.ts writes to ingest_run_sources.provider_requests.
    assertEquals(err.providerRequests, c.expected, `${c.name}: recorded provider_requests`);
  }
});

Deno.test("quota: a failure on page 2 adds to the page-1 total, not MAX_ATTEMPTS", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { body: [post("7473335599555338240", "a", daysAgo(1))] }, // page 1 ok  (1)
    { status: 401 },                                          // page 2 auth (1)
  ]);
  const err = await assertRejects(
    () => collectCompanyPosts(URL_, 30, opts(fetchImpl)),
    ProviderError,
  );
  assertEquals(calls.length, 2);
  assertEquals(err.attempts, 1, "attempts for the failing page only");
  assertEquals(err.providerRequests, 2, "running total across the source");
});

Deno.test("quota: 429 then success -> 2 attempts, 1 page", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 429, headers: { "Retry-After": "30" } },
    { body: [post("7473335599555338240", "a", daysAgo(1))] },
  ]);
  // 429 is not retried inside fetchPage; it surfaces so the source is recorded
  // as rate_limited rather than hammered.
  await assertRejects(() => collectCompanyPosts(URL_, 30, opts(fetchImpl)), ProviderError);
  assertEquals(calls.length, 1);
});

Deno.test("quota: immediate 401 -> 1 attempt, 0 pages, not retried", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ status: 401 }]);
  const err = await assertRejects(
    () => collectCompanyPosts(URL_, 30, opts(fetchImpl)),
    ProviderError,
  );
  assertEquals(err.code, "auth");
  assertEquals(calls.length, 1, "a bad key is not worth retrying");
});

Deno.test("quota: retry exhaustion -> 3 attempts, 0 pages", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { status: 503 }, { status: 503 }, { status: 503 },
  ]);
  const err = await assertRejects(
    () => collectCompanyPosts(URL_, 30, opts(fetchImpl)),
    ProviderError,
  );
  assertEquals(calls.length, 3);
  assertEquals(err.code, "server_error");
  // The attempts are surfaced so the caller can still bill them to the run.
  assertEquals((err as ProviderError & { providerRequests?: number }).providerRequests, 3);
});

Deno.test("quota: three clean pages -> 3 attempts, 3 pages", async () => {
  const { fetchImpl, calls } = scriptedFetch([
    { body: [post("7473335599555338240", "a", daysAgo(1))] },
    { body: [post("7473335599555338241", "b", daysAgo(2))] },
    { body: [post("7473335599555338242", "c", daysAgo(3))] },
    { body: [] },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.pagesFetched, 3);
  assertEquals(r.providerRequests, calls.length);
  assertEquals(r.posts.length, 3);
});

// ===========================================================================
// PAGINATION STOP CONDITIONS
// ===========================================================================
Deno.test("pagination: empty page stops", async () => {
  const { fetchImpl } = scriptedFetch([
    { body: [post("7473335599555338240", "a", daysAgo(1))] },
    { body: [] },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.pagesFetched, 1);
  assertEquals(r.truncated, false);
});

Deno.test("pagination: a page entirely older than the window stops", async () => {
  const { fetchImpl } = scriptedFetch([
    { body: [post("7473335599555338240", "recent", daysAgo(2))] },
    { body: [post("7473335599555338241", "old", daysAgo(400))] },
    { body: [post("7473335599555338242", "never reached", daysAgo(3))] },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.pagesFetched, 2);
  assertEquals(r.posts.length, 1);
  assertEquals(r.outOfWindow, 1);
});

Deno.test("pagination: repeated page stops (provider ignoring `start`)", async () => {
  const same = [post("7473335599555338240", "a", daysAgo(1))];
  const { fetchImpl, calls } = scriptedFetch([{ body: same }, { body: same }, { body: same }]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.posts.length, 1, "the duplicate is not collected twice");
  assert(calls.length < MAX_PAGES, "stopped before burning the page cap");
});

Deno.test("pagination: hard cap reached -> truncated = true", async () => {
  const script = Array.from({ length: 8 }, (_v, i) => ({
    body: [post(`747333559955533${8240 + i}`, `p${i}`, daysAgo(i + 1))],
  }));
  const { fetchImpl, calls } = scriptedFetch(script);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.pagesFetched, MAX_PAGES);
  assertEquals(calls.length, MAX_PAGES, "the cap bounds quota, not just output");
  assertEquals(r.truncated, true);
});

// ===========================================================================
// TIMEOUT AND BUDGET
// ===========================================================================
Deno.test("timeout: a hung request aborts and counts as an attempt", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ hang: true }]);
  const err = await assertRejects(
    () => fetchPage(URL_, 0, { apiKey: "k", fetchImpl, sleep: noSleep }),
    ProviderError,
  );
  assertEquals(err.code, "timeout");
  assertEquals(calls.length, 3, "timeouts are retryable, so all attempts are spent");
});

Deno.test("budget: an exhausted deadline stops before any HTTP call", async () => {
  const { fetchImpl, calls } = scriptedFetch([{ body: [] }]);
  const err = await assertRejects(
    () => collectCompanyPosts(URL_, 30, { apiKey: "k", fetchImpl, sleep: noSleep, deadline: Date.now() - 1 }),
    ProviderError,
  );
  assertEquals(err.code, "budget_exhausted");
  assertEquals(calls.length, 0, "no quota is spent once the budget is gone");
});

// ===========================================================================
// MALFORMED RESPONSES
// ===========================================================================
Deno.test("malformed: unparseable JSON is its own error code", async () => {
  const { fetchImpl } = scriptedFetch([{ body: "<html>not json</html>" }]);
  const err = await assertRejects(
    () => fetchPage(URL_, 0, { apiKey: "k", fetchImpl, sleep: noSleep }),
    ProviderError,
  );
  assertEquals(err.code, "malformed_response");
});

Deno.test("empty response is not an error", async () => {
  const { fetchImpl } = scriptedFetch([{ body: [] }]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.posts.length, 0);
  assertEquals(r.pagesFetched, 0);
  assertEquals(r.providerRequests, 1);
});

Deno.test("network failure maps to the network code", async () => {
  const { fetchImpl } = scriptedFetch([{ throws: "network" }]);
  const err = await assertRejects(
    () => fetchPage(URL_, 0, { apiKey: "k", fetchImpl, sleep: noSleep }),
    ProviderError,
  );
  assertEquals(err.code, "network");
});

Deno.test("wrapped response shapes page correctly", async () => {
  const { fetchImpl } = scriptedFetch([
    { body: { data: [post("7473335599555338240", "a", daysAgo(1))] } },
    { body: { posts: [] } },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.posts.length, 1);
});

Deno.test("posts with no provider id are skipped and counted", async () => {
  const { fetchImpl } = scriptedFetch([
    { body: [{ text: "no id", postedAt: daysAgo(1) }, post("7473335599555338240", "ok", daysAgo(1))] },
    { body: [] },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.posts.length, 1);
  assertEquals(r.skippedNoId, 1);
  assertEquals(r.skippedMalformed, 0);
});

Deno.test("malformed posts are counted separately from missing ids", async () => {
  // Both are unusable, but they indicate different provider problems: no id
  // means we cannot deduplicate, malformed means the payload is incomplete.
  const { fetchImpl } = scriptedFetch([
    {
      body: [
        post("7473335599555338240", "good", daysAgo(1)),
        { text: "no id at all", postedAt: daysAgo(1) },
        { urn: "urn:li:activity:7473335599555338241", text: "", postedAt: daysAgo(1) },
        { urn: "urn:li:activity:7473335599555338242", text: "no date" },
        { urn: "urn:li:activity:7473335599555338243", text: "bad date", postedAt: "garbage" },
      ],
    },
    { body: [] },
  ]);
  const r = await collectCompanyPosts(URL_, 30, opts(fetchImpl));
  assertEquals(r.posts.length, 1);
  assertEquals(r.skippedNoId, 1, "missing identifier");
  assertEquals(r.skippedMalformed, 3, "empty text, missing date, unparseable date");
  assertEquals(r.rawCount, 5, "everything the provider returned is counted as fetched");
});

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
});

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { LOOKBACK_MAX, LOOKBACK_MIN, MAX_SOURCES_PER_RUN, parseRequest } from "../request.ts";
import { RequestError } from "../../_shared/errors.ts";
import { corsHeaders, handlePreflight, isAllowedOrigin } from "../../_shared/cors.ts";

const UUID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Bounds are enforced server side. The UI is not a security control.
// ---------------------------------------------------------------------------
Deno.test("lookback: accepted at both ends of the range", () => {
  assertEquals(parseRequest({ lookback_days: LOOKBACK_MIN }).lookbackOverride, 1);
  assertEquals(parseRequest({ lookback_days: LOOKBACK_MAX }).lookbackOverride, 90);
});

Deno.test("lookback: out-of-range and non-integer values are rejected", () => {
  for (const v of [0, -1, 91, 1000, 1.5, "30", true, [], {}]) {
    assertThrows(() => parseRequest({ lookback_days: v }), RequestError, undefined, String(v));
  }
});

Deno.test("lookback: omitted or null falls back to the per-source value", () => {
  assertEquals(parseRequest({}).lookbackOverride, null);
  assertEquals(parseRequest({ lookback_days: null }).lookbackOverride, null);
});

Deno.test("source_ids: must be uuids", () => {
  assertThrows(() => parseRequest({ source_ids: ["nope"] }), RequestError);
  assertThrows(() => parseRequest({ source_ids: [123] }), RequestError);
  assertThrows(() => parseRequest({ source_ids: "not-an-array" }), RequestError);
  assertEquals(parseRequest({ source_ids: [UUID] }).sourceIds, [UUID]);
});

Deno.test("source_ids: empty array is a mistake, not 'everything'", () => {
  // Silently collecting every source because the caller sent [] would be a
  // surprising way to spend quota.
  assertThrows(() => parseRequest({ source_ids: [] }), RequestError);
});

Deno.test("source_ids: omitted means every enabled source", () => {
  assertEquals(parseRequest({}).sourceIds, null);
});

Deno.test("source_ids: duplicates collapse, oversized lists rejected", () => {
  assertEquals(parseRequest({ source_ids: [UUID, UUID] }).sourceIds, [UUID]);
  const many = Array.from(
    { length: MAX_SOURCES_PER_RUN + 1 },
    (_v, i) => `1111111${String(i).padStart(4, "0")}-1111-1111-1111-111111111111`.slice(0, 36),
  );
  assertThrows(() => parseRequest({ source_ids: many }), RequestError);
});

Deno.test("dry_run: boolean only, defaults false", () => {
  assertEquals(parseRequest({}).dryRun, false);
  assertEquals(parseRequest({ dry_run: true }).dryRun, true);
  assertThrows(() => parseRequest({ dry_run: "yes" }), RequestError);
});

Deno.test("body must be a JSON object", () => {
  for (const v of [null, [], "x", 42]) {
    assertThrows(() => parseRequest(v), RequestError, undefined, String(v));
  }
});

Deno.test("trigger_source in the body is ignored by the parser", () => {
  // It is derived from the credential in auth.ts. Nothing here reads it.
  const parsed = parseRequest({ trigger_source: "cron" }) as unknown as Record<string, unknown>;
  assertEquals(parsed.triggerSource, undefined);
  assertEquals(Object.keys(parsed).sort(), ["dryRun", "lookbackOverride", "sourceIds"]);
});

// ---------------------------------------------------------------------------
// CORS: no wildcard, ever
// ---------------------------------------------------------------------------
Deno.test("cors: unlisted origins get no headers", () => {
  Deno.env.set("ALLOWED_ORIGINS", "https://cues.example.com");
  assertEquals(isAllowedOrigin("https://cues.example.com"), true);
  assertEquals(isAllowedOrigin("https://evil.example.com"), false);
  assertEquals(Object.keys(corsHeaders("https://evil.example.com")).length, 0);
  assertEquals(corsHeaders("https://cues.example.com")["Access-Control-Allow-Origin"], "https://cues.example.com");
  Deno.env.delete("ALLOWED_ORIGINS");
});

Deno.test("cors: never emits a wildcard", () => {
  Deno.env.set("ALLOWED_ORIGINS", "https://cues.example.com");
  const headers = corsHeaders("https://cues.example.com");
  assertEquals(headers["Access-Control-Allow-Origin"] === "*", false);
  Deno.env.delete("ALLOWED_ORIGINS");
});

Deno.test("cors: preflight answered without auth and without a run", () => {
  Deno.env.set("ALLOWED_ORIGINS", "https://cues.example.com");
  const ok = handlePreflight(
    new Request("https://x/ingest", { method: "OPTIONS", headers: { Origin: "https://cues.example.com" } }),
  );
  assertEquals(ok?.status, 204);

  const blocked = handlePreflight(
    new Request("https://x/ingest", { method: "OPTIONS", headers: { Origin: "https://evil.example.com" } }),
  );
  assertEquals(blocked?.status, 403);

  assertEquals(handlePreflight(new Request("https://x/ingest", { method: "POST" })), null);
  Deno.env.delete("ALLOWED_ORIGINS");
});

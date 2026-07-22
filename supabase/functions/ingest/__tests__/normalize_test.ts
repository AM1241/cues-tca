import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  extractPostsArray,
  isWithinLookback,
  normalizeExternalId,
  normalizePage,
  normalizePost,
  parsePublishedAt,
} from "../normalize.ts";

// ---------------------------------------------------------------------------
// Response shape variance
// ---------------------------------------------------------------------------
Deno.test("extractPostsArray: bare array", () => {
  assertEquals(extractPostsArray([{ a: 1 }]).length, 1);
});

Deno.test("extractPostsArray: every documented wrapper key", () => {
  for (const key of ["data", "posts", "items", "results"]) {
    assertEquals(extractPostsArray({ [key]: [{ a: 1 }, { b: 2 }] }).length, 2, key);
  }
});

Deno.test("extractPostsArray: unknown shapes yield nothing rather than throwing", () => {
  for (const v of [null, undefined, 42, "x", {}, { other: [1] }]) {
    assertEquals(extractPostsArray(v).length, 0);
  }
});

// ---------------------------------------------------------------------------
// Identifier normalisation — the Phase 1 <-> Phase 2 join
// ---------------------------------------------------------------------------
Deno.test("normalizeExternalId: all supported forms reduce to the same digits", () => {
  const id = "7473335599555338240";
  assertEquals(normalizeExternalId(`urn:li:activity:${id}`), id);
  assertEquals(normalizeExternalId(`urn:li:ugcPost:${id}`), id);
  assertEquals(normalizeExternalId(`urn:li:share:${id}`), id);
  assertEquals(
    normalizeExternalId(`https://www.linkedin.com/posts/masaf_40-anni-activity-${id}-iGps`),
    id,
  );
  assertEquals(
    normalizeExternalId(`https://www.linkedin.com/posts/vinitaly_x-ugcPost-${id}-yaNX`),
    id,
  );
  assertEquals(normalizeExternalId(id), id);
});

Deno.test("normalizeExternalId: rejects the scraper's local fallbacks", () => {
  // url-<sha> / hash-<sha> are inventions, not provider identities. Accepting
  // them would let the same post arrive under two different ids.
  assertEquals(normalizeExternalId("url-a1b2c3d4e5f60718"), null);
  assertEquals(normalizeExternalId("hash-a1b2c3d4e5f60718"), null);
  assertEquals(normalizeExternalId(""), null);
  assertEquals(normalizeExternalId(null), null);
  assertEquals(normalizeExternalId(12345), null);
  assertEquals(normalizeExternalId("12345"), null); // too short to be an activity id
});

Deno.test("normalizeExternalId: URN and permalink for one post agree", () => {
  const fromUrn = normalizeExternalId("urn:li:activity:7449116886476259328");
  const fromUrl = normalizeExternalId(
    "https://www.linkedin.com/posts/vinitaly_veronafiere-ugcPost-7449116886476259328-yaNX",
  );
  assertEquals(fromUrn, "7449116886476259328");
  // Different post families, same digits: this is what stops a re-ingest of a
  // migrated post being stored twice.
  assertEquals(fromUrl, "7449116886476259328");
});

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------
Deno.test("normalizePost: id read from each accepted field", () => {
  for (const field of ["urn", "id", "postUrn", "post_urn", "entityUrn", "post_id"]) {
    const r = normalizePost({
      [field]: "7473335599555338240",
      text: "hello",
      postedAt: "2026-06-18 11:27:34",
    });
    assert(r.ok, field);
    if (r.ok) assertEquals(r.post.externalPostId, "7473335599555338240");
  }
});

Deno.test("normalizePost: text read from each accepted field", () => {
  for (const field of ["text", "commentary", "description", "content", "body"]) {
    const r = normalizePost({
      urn: "7473335599555338240",
      [field]: "body text",
      postedAt: "2026-06-18 11:27:34",
    });
    assert(r.ok, field);
    if (r.ok) assertEquals(r.post.postText, "body text");
  }
});

Deno.test("normalizePost: no identifier anywhere -> skipped, never invented", () => {
  const r = normalizePost({ text: "hello", postedAt: "2026-06-18 11:27:34" });
  assert(!r.ok);
  if (!r.ok) assertEquals(r.reason, "no_id");
});

Deno.test("normalizePost: id recovered from the permalink when no id field exists", () => {
  const r = normalizePost({
    url: "https://www.linkedin.com/posts/masaf_x-activity-7473335599555338240-iGps",
    text: "hello",
    postedAt: "2026-06-18 11:27:34",
  });
  assert(r.ok);
  if (r.ok) assertEquals(r.post.externalPostId, "7473335599555338240");
});

Deno.test("normalizePost: empty text -> skipped", () => {
  const r = normalizePost({ urn: "7473335599555338240", text: "   ", postedAt: 1750000000 });
  assert(!r.ok);
  if (!r.ok) assertEquals(r.reason, "no_text");
});

Deno.test("normalizePost: unparseable date -> skipped, NOT defaulted to now", () => {
  // Defaulting would put the post inside every lookback window forever.
  const r = normalizePost({ urn: "7473335599555338240", text: "hi", postedAt: "not a date" });
  assert(!r.ok);
  if (!r.ok) assertEquals(r.reason, "no_published_at");
});

Deno.test("normalizePost: author from poster.name, else fallbacks", () => {
  const withPoster = normalizePost({
    urn: "7473335599555338240", text: "hi", postedAt: 1750000000,
    poster: { name: "MASAF" },
  });
  assert(withPoster.ok);
  if (withPoster.ok) assertEquals(withPoster.post.author, "MASAF");

  const without = normalizePost({ urn: "7473335599555338240", text: "hi", postedAt: 1750000000 });
  assert(without.ok);
  if (without.ok) assertEquals(without.post.author, null);
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------
Deno.test("parsePublishedAt: epoch seconds, milliseconds, and numeric strings", () => {
  assertEquals(parsePublishedAt(1750000000), "2025-06-15T15:06:40.000Z");
  assertEquals(parsePublishedAt(1750000000000), "2025-06-15T15:06:40.000Z");
  assertEquals(parsePublishedAt("1750000000"), "2025-06-15T15:06:40.000Z");
});

Deno.test("parsePublishedAt: naive datetimes are read as UTC", () => {
  // The legacy system stored naive datetime.utcnow(); reading these in the
  // runtime's local zone would shift every post by the host offset.
  assertEquals(parsePublishedAt("2026-06-18 11:27:34"), "2026-06-18T11:27:34.000Z");
  assertEquals(parsePublishedAt("2026-06-18T11:27:34"), "2026-06-18T11:27:34.000Z");
});

Deno.test("parsePublishedAt: ISO-8601 with offset is respected", () => {
  assertEquals(parsePublishedAt("2026-06-18T11:27:34Z"), "2026-06-18T11:27:34.000Z");
  assertEquals(parsePublishedAt("2026-06-18T13:27:34+02:00"), "2026-06-18T11:27:34.000Z");
});

Deno.test("parsePublishedAt: junk yields null", () => {
  for (const v of ["", "   ", "not a date", null, undefined, {}, 0, -5]) {
    assertEquals(parsePublishedAt(v), null, String(v));
  }
});

// ---------------------------------------------------------------------------
// Lookback window
// ---------------------------------------------------------------------------
Deno.test("isWithinLookback: boundary is inclusive", () => {
  const now = new Date("2026-07-22T00:00:00Z");
  assert(isWithinLookback("2026-06-22T00:00:00Z", 30, now));
  assert(!isWithinLookback("2026-06-21T23:59:59Z", 30, now));
  assert(isWithinLookback("2026-07-21T00:00:00Z", 30, now));
});

// ---------------------------------------------------------------------------
// Page-level counting
// ---------------------------------------------------------------------------
Deno.test("normalizePage: counts good, no-id and malformed separately", () => {
  const page = normalizePage({
    data: [
      { urn: "7473335599555338240", text: "a", postedAt: 1750000000 },
      { text: "no id here", postedAt: 1750000000 },
      { urn: "7473335599555338241", text: "", postedAt: 1750000000 },
      { urn: "7473335599555338242", text: "c", postedAt: "garbage" },
    ],
  });
  assertEquals(page.posts.length, 1);
  assertEquals(page.skippedNoId, 1);
  assertEquals(page.skippedMalformed, 2);
});

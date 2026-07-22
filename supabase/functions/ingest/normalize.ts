/**
 * Provider JSON -> canonical post. Pure: no network, no database, no clock
 * except what the caller passes in. This is where the response variance
 * documented in ../../../../linkedin_rapidapi_scraper/parser.py is absorbed.
 */
import type { NormalizedPost, NormalizeResult } from "./types.ts";

/** The response is sometimes a bare array, sometimes wrapped. */
export function extractPostsArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    for (const key of ["data", "posts", "items", "results"]) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/**
 * Reduce any known LinkedIn identifier form to the bare numeric activity id.
 *
 * This is the join between Phase 1 and Phase 2: the 132 migrated posts had
 * their external_post_id recovered from the permalink, so a post arriving now
 * as a URN must reduce to the same digits or it would be stored as a duplicate.
 *
 * Returns null when no stable id can be derived. We never invent one — an
 * identity we made up cannot deduplicate anything on the next run.
 */
export function normalizeExternalId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  // urn:li:activity:123 / urn:li:ugcPost:123 (and share/comment variants)
  const urn = /^urn:li:[A-Za-z]+:(\d{6,})$/.exec(value);
  if (urn) return urn[1];

  // .../posts/slug-activity-123-AbCd or -ugcPost-123-AbCd
  const inUrl = /(?:activity|ugcPost|ugcpost)[-:](\d{6,})/i.exec(value);
  if (inUrl) return inUrl[1];

  // Already bare digits.
  if (/^\d{6,}$/.test(value)) return value;

  // Deliberately unsupported: the scraper's url-<sha> / hash-<sha> fallbacks.
  // Those are not provider identities, they are local inventions.
  return null;
}

function firstString(
  post: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const f of fields) {
    const v = post[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function extractText(post: Record<string, unknown>): string | null {
  return firstString(post, ["text", "commentary", "description", "content", "body"]);
}

export function extractUrl(post: Record<string, unknown>): string | null {
  return firstString(post, ["url", "postUrl", "post_url", "permalink", "link"]);
}

export function extractExternalId(post: Record<string, unknown>): string | null {
  for (const f of ["urn", "id", "postUrn", "post_urn", "entityUrn", "post_id"]) {
    const id = normalizeExternalId(post[f]);
    if (id) return id;
  }
  // Fall back to digging the id out of the permalink before giving up.
  return normalizeExternalId(extractUrl(post));
}

export function extractAuthor(post: Record<string, unknown>): string | null {
  const poster = post["poster"];
  if (poster && typeof poster === "object") {
    const name = (poster as Record<string, unknown>)["name"];
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return firstString(post, ["author", "companyName", "company"]);
}

const TIME_FIELDS = [
  "postedAt", "posted_at", "publishedAt", "published_at", "posted", "date", "time",
];

/**
 * Provider timestamps arrive as epoch seconds, epoch milliseconds, epoch as a
 * string, "YYYY-MM-DD HH:MM:SS", or ISO-8601. Naive forms are read as UTC,
 * matching how the legacy system stored them.
 *
 * Returns null rather than defaulting to now(): a post with an unreadable date
 * would otherwise land inside every lookback window forever.
 */
export function parsePublishedAt(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Heuristic: 1e12 separates seconds from milliseconds until the year 33658.
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;

  // "2026-06-18 11:27:34" -> treat as UTC, not as the runtime's local zone.
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?)$/.exec(s);
  if (naive) {
    const d = new Date(`${naive[1]}T${naive[2]}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function extractPublishedAt(post: Record<string, unknown>): string | null {
  for (const f of TIME_FIELDS) {
    if (post[f] !== undefined && post[f] !== null) {
      const parsed = parsePublishedAt(post[f]);
      if (parsed) return parsed;
    }
  }
  return null;
}

function extractMediaUrls(post: Record<string, unknown>): string[] {
  for (const f of ["media_urls", "mediaUrls", "images", "media"]) {
    const v = post[f];
    if (Array.isArray(v)) {
      return v
        .map((m) =>
          typeof m === "string"
            ? m
            : (m && typeof m === "object" && typeof (m as Record<string, unknown>).url === "string")
            ? (m as Record<string, string>).url
            : null
        )
        .filter((m): m is string => !!m);
    }
  }
  return [];
}

function extractEngagement(post: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Record<string, string[]> = {
    likes: ["num_likes", "numLikes", "likes", "reactions"],
    comments: ["num_comments", "numComments", "comments"],
    shares: ["num_shares", "numShares", "shares", "reposts"],
  };
  for (const [key, fields] of Object.entries(map)) {
    for (const f of fields) {
      const v = post[f];
      if (typeof v === "number") { out[key] = v; break; }
      if (typeof v === "string" && /^\d+$/.test(v)) { out[key] = Number(v); break; }
    }
  }
  return out;
}

/** One provider post -> canonical, or null with the reason it was unusable. */
export function normalizePost(
  post: Record<string, unknown>,
): { ok: true; post: NormalizedPost } | { ok: false; reason: "no_id" | "no_text" | "no_published_at" } {
  const externalPostId = extractExternalId(post);
  if (!externalPostId) return { ok: false, reason: "no_id" };

  const postText = extractText(post);
  if (!postText) return { ok: false, reason: "no_text" };

  const publishedAt = extractPublishedAt(post);
  if (!publishedAt) return { ok: false, reason: "no_published_at" };

  return {
    ok: true,
    post: {
      externalPostId,
      postText,
      sourceUrl: extractUrl(post) ?? "",
      author: extractAuthor(post),
      publishedAt,
      mediaUrls: extractMediaUrls(post),
      engagementMetrics: extractEngagement(post),
    },
  };
}

export function normalizePage(data: unknown): NormalizeResult {
  const raw = extractPostsArray(data);
  const posts: NormalizedPost[] = [];
  let skippedNoId = 0;
  let skippedMalformed = 0;

  for (const p of raw) {
    const r = normalizePost(p);
    if (r.ok) posts.push(r.post);
    else if (r.reason === "no_id") skippedNoId++;
    else skippedMalformed++;
  }
  return { posts, skippedNoId, skippedMalformed };
}

/** Inclusive lower bound: published_at >= now - lookbackDays. */
export function isWithinLookback(
  publishedAtIso: string,
  lookbackDays: number,
  now: Date = new Date(),
): boolean {
  const cutoff = now.getTime() - lookbackDays * 86_400_000;
  const t = new Date(publishedAtIso).getTime();
  return Number.isFinite(t) && t >= cutoff;
}

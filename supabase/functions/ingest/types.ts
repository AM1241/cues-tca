/** Canonical post shape produced by normalize.ts and consumed by upsert.ts. */
export interface NormalizedPost {
  externalPostId: string;
  postText: string;
  sourceUrl: string;
  author: string | null;
  publishedAt: string; // ISO-8601 UTC
  mediaUrls: string[];
  engagementMetrics: Record<string, unknown>;
}

/** Why a provider post was not stored. */
export type SkipReason = "no_id" | "no_text" | "no_published_at" | "out_of_window";

export interface NormalizeResult {
  posts: NormalizedPost[];
  skippedNoId: number;
  skippedMalformed: number;
}

export interface SourceCounters {
  pages_fetched: number;
  provider_requests: number;
  truncated: boolean;
  posts_fetched: number;
  posts_inserted: number;
  posts_metadata_refreshed: number;
  posts_content_changed: number;
  posts_skipped_duplicate: number;
  posts_skipped_no_id: number;
  /** Had an id but no usable text, or no parseable published_at. */
  posts_skipped_malformed: number;
  posts_skipped_out_of_window: number;
}

export function emptyCounters(): SourceCounters {
  return {
    pages_fetched: 0,
    provider_requests: 0,
    truncated: false,
    posts_fetched: 0,
    posts_inserted: 0,
    posts_metadata_refreshed: 0,
    posts_content_changed: 0,
    posts_skipped_duplicate: 0,
    posts_skipped_no_id: 0,
    posts_skipped_malformed: 0,
    posts_skipped_out_of_window: 0,
  };
}

export interface SourceRow {
  id: string;
  name: string;
  enabled: boolean;
  rapidapi_identifier: string | null;
  lookback_days: number;
}

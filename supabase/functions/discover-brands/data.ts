/** Data access for discover-brands. See supabase/migrations/0020_brand_suggestions.sql. */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";

export interface SourceRow {
  id: string;
  name: string;
  lookback_days: number;
}

export async function getSource(db: SupabaseClient, sourceId: string): Promise<SourceRow | null> {
  const { data, error } = await db
    .from("sources")
    .select("id, name, lookback_days")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw new Error(`sources lookup failed: ${error.message}`);
  return data as unknown as SourceRow | null;
}

export interface DiscoveryConfigRow {
  editorial_domain: string | null;
  company_aliases: Record<string, string> | null;
}

export async function getConfig(db: SupabaseClient): Promise<DiscoveryConfigRow> {
  const { data, error } = await db
    .from("configurations")
    .select("editorial_domain, company_aliases")
    .eq("id", "default")
    .single();
  if (error) throw new Error(`configurations lookup failed: ${error.message}`);
  return data as unknown as DiscoveryConfigRow;
}

/**
 * The source's own posts, newest first, RAW text — deliberately: the whole
 * point is to see the names before anonymisation removes the ones it already
 * knows.
 *
 * Bounded to `sinceIso`, the same lookback window Collect actually uses for
 * this source (see index.ts). Before this, a source with a long collection
 * history could surface names from posts far older than anything the pipeline
 * is currently working with — proposals about last year's copy while the
 * editor is looking at this week's. `limit` still caps how many posts reach
 * one LLM call; the date filter is what decides which ones are eligible.
 */
export async function getSourcePosts(
  db: SupabaseClient,
  sourceId: string,
  limit: number,
  sinceIso: string,
): Promise<{ text: string }[]> {
  const { data, error } = await db
    .from("raw_posts")
    .select("post_text, published_at")
    .eq("source_id", sourceId)
    .gte("published_at", sinceIso)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`raw_posts lookup failed: ${error.message}`);
  return ((data ?? []) as unknown as { post_text: string }[])
    .map((r) => ({ text: r.post_text }))
    .filter((p) => p.text && p.text.trim().length > 0);
}

/** Names already decided for this source — proposed once, in either direction. */
export async function getExistingSuggestions(
  db: SupabaseClient,
  sourceId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from("brand_suggestions")
    .select("name")
    .eq("source_id", sourceId);
  if (error) throw new Error(`brand_suggestions lookup failed: ${error.message}`);
  return ((data ?? []) as unknown as { name: string }[]).map((r) => r.name);
}

export interface InsertedSuggestion {
  id: string;
  name: string;
  rationale: string | null;
  status: string;
}

/**
 * Insert the survivors, one at a time.
 *
 * 0020's uniqueness is on the EXPRESSION (source_id, lower(name)), which
 * PostgREST cannot name in an `onConflict`, so a batch upsert is not available.
 * Row-at-a-time also means one duplicate does not discard the rest of the batch.
 * A 23505 is the index doing its job — a concurrent run, or a name that slipped
 * past the in-memory filter — and is skipped, the same way ingest/upsert.ts
 * treats a duplicate post.
 */
export async function insertSuggestions(
  db: SupabaseClient,
  sourceId: string,
  names: { name: string; rationale: string }[],
): Promise<InsertedSuggestion[]> {
  const inserted: InsertedSuggestion[] = [];
  for (const n of names) {
    const { data, error } = await db
      .from("brand_suggestions")
      .insert({ source_id: sourceId, name: n.name, rationale: n.rationale })
      .select("id, name, rationale, status")
      .single();
    if (error) {
      if (error.code === "23505") continue;
      throw new Error(`brand_suggestions insert failed: ${error.message}`);
    }
    inserted.push(data as unknown as InsertedSuggestion);
  }
  return inserted;
}

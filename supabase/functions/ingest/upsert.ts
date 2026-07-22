/**
 * Storing a post. Three outcomes, and only one of them writes post text.
 *
 *   inserted           — no row for (source_id, external_post_id)
 *   metadata_refreshed — row exists, text identical: refresh mutable metadata
 *   content_changed    — row exists, text DIFFERENT: refresh mutable metadata,
 *                        park the observed text in raw_post_content_changes,
 *                        leave post_text and content_hash alone
 *
 * The third case is the important one. normalized_posts, analyzed_posts and
 * anonymized_posts_current are all derived from post_text; rewriting it in
 * place would leave scores and anonymisations describing copy that no longer
 * exists, with nothing recording that it happened. Applying an observed version
 * is a deliberate later operation that must also mark those downstream rows for
 * reprocessing.
 *
 * Note that "leave the text alone" is not "leave the row alone": last_seen_at,
 * source_url, media_urls and engagement_metrics are refreshed in all three
 * cases, because those are provider facts that legitimately change.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { NormalizedPost } from "./types.ts";

export type UpsertOutcome = "inserted" | "metadata_refreshed" | "content_changed";

export async function upsertPost(
  db: SupabaseClient,
  sourceId: string,
  runId: string,
  post: NormalizedPost,
  seenAt: string,
): Promise<UpsertOutcome> {
  const findExisting = async (): Promise<{ id: string } | null> => {
    const { data, error } = await db
      .from("raw_posts")
      .select("id")
      .eq("source_id", sourceId)
      .eq("external_post_id", post.externalPostId)
      .maybeSingle();
    if (error) throw new Error(`raw_posts lookup failed: ${error.message}`);
    return data ?? null;
  };

  let existing = await findExisting();

  // ---- new post ----------------------------------------------------------
  if (!existing) {
    const { error } = await db.from("raw_posts").insert({
      source_id: sourceId,
      external_post_id: post.externalPostId,
      source_url: post.sourceUrl,
      post_text: post.postText,
      author: post.author,
      published_at: post.publishedAt,
      collected_at: seenAt,
      last_seen_at: seenAt,
      media_urls: post.mediaUrls,
      engagement_metrics: post.engagementMetrics,
    });

    if (!error) return "inserted";
    if (error.code !== "23505") throw new Error(`raw_posts insert failed: ${error.message}`);

    // A concurrent run won the race between our select and insert. That row is
    // now the one of record, so fall through to the same refresh path any
    // repeat sighting takes — returning early here would skip the metadata
    // update and, worse, skip content-change detection entirely.
    existing = await findExisting();
    if (!existing) {
      throw new Error(
        `raw_posts insert conflicted on (source_id, external_post_id) but no row was found afterwards`,
      );
    }
  }

  // ---- mutable metadata, refreshed in every existing-row case ------------
  const { error: updErr } = await db
    .from("raw_posts")
    .update({
      last_seen_at: seenAt,
      source_url: post.sourceUrl,
      media_urls: post.mediaUrls,
      engagement_metrics: post.engagementMetrics,
    })
    .eq("id", existing.id);
  if (updErr) throw new Error(`raw_posts metadata refresh failed: ${updErr.message}`);

  // ---- did the text change? ---------------------------------------------
  // Delegated to SQL: content_hash is `generated always as (md5(post_text))`,
  // so the comparison and the deduplicating insert both belong where that
  // definition lives. Returns true when a change was recorded.
  const { data: changed, error: rpcErr } = await db.rpc("record_content_change", {
    p_raw_post_id: existing.id,
    p_run_id: runId,
    p_observed_text: post.postText,
  });
  if (rpcErr) throw new Error(`record_content_change failed: ${rpcErr.message}`);

  return changed === true ? "content_changed" : "metadata_refreshed";
}

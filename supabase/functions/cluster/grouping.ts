/**
 * Similarity grouping — pure TypeScript, runs after embeddings are already
 * fetched (see PHASE4_REQUIREMENTS.md §3 / the checkpoint-5 review decision:
 * grouping math lives here, not in SQL, so it's testable with plain unit
 * fixtures rather than requiring the local Postgres stack).
 *
 * Algorithm: greedy single-link clustering. Each post joins the first
 * existing cluster whose centroid similarity is >= threshold; otherwise it
 * starts a new cluster. Clusters smaller than min_cluster_size are dropped
 * (their posts become unclustered, not force-merged into a fallback bucket —
 * PHASE4_REQUIREMENTS.md's "must not collapse into one meaningless fallback
 * cluster" bar). This is intentionally simple: recompute-all per run means
 * there's no persistent centroid state to get elaborate about.
 */

export interface EmbeddedPost {
  rawPostId: string;
  embedding: number[];
}

export interface GroupedCluster {
  postIds: string[];
  centroid: number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function centroidOf(embeddings: number[][]): number[] {
  const dim = embeddings[0].length;
  const sum = new Array(dim).fill(0);
  for (const e of embeddings) {
    for (let i = 0; i < dim; i++) sum[i] += e[i];
  }
  return sum.map((v) => v / embeddings.length);
}

/**
 * Groups posts by greedy single-link cosine similarity, then drops clusters
 * smaller than minClusterSize.
 *
 * The algorithm is order-sensitive (the first post seen anchors a cluster's
 * initial centroid, and ties are broken by insertion order), so determinism
 * cannot depend on callers happening to pass an already-sorted array — this
 * function sorts by rawPostId itself before grouping, so the same input SET
 * always produces the same clustering regardless of what order the caller's
 * query returned rows in.
 */
export function groupBySimilarity(
  posts: EmbeddedPost[],
  similarityThreshold: number,
  minClusterSize: number,
): { clusters: GroupedCluster[]; unclustered: string[] } {
  const ordered = [...posts].sort((a, b) => a.rawPostId.localeCompare(b.rawPostId));
  const working: { postIds: string[]; embeddings: number[][]; centroid: number[] }[] = [];

  for (const post of ordered) {
    let best: { index: number; score: number } | null = null;
    for (let i = 0; i < working.length; i++) {
      const score = cosineSimilarity(post.embedding, working[i].centroid);
      if (score >= similarityThreshold && (!best || score > best.score)) {
        best = { index: i, score };
      }
    }
    if (best) {
      const cluster = working[best.index];
      cluster.postIds.push(post.rawPostId);
      cluster.embeddings.push(post.embedding);
      cluster.centroid = centroidOf(cluster.embeddings);
    } else {
      working.push({ postIds: [post.rawPostId], embeddings: [post.embedding], centroid: post.embedding });
    }
  }

  const clusters: GroupedCluster[] = [];
  const unclustered: string[] = [];
  for (const w of working) {
    if (w.postIds.length >= minClusterSize) {
      clusters.push({ postIds: w.postIds, centroid: w.centroid });
    } else {
      unclustered.push(...w.postIds);
    }
  }
  return { clusters, unclustered };
}

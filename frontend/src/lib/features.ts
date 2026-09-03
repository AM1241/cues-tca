/**
 * Build-time feature switches.
 *
 * These are plain constants, not runtime config: flipping one is a code change
 * that goes through review and a deploy, which is what we want for a switch
 * that changes what the product *is* rather than how it behaves for one user.
 */

/**
 * Per-cluster generation — one post and one carousel for EACH selected cluster.
 *
 * This is how generation was built through session 16, and it is not what the
 * CUES brief asks for. The specification wants one publication per period whose
 * sections are the themes; per-cluster generation turns an eight-theme run into
 * sixteen unrelated drafts and asks an editor to pick between them.
 *
 * Switched off rather than deleted, on the operator's instruction: it may come
 * back as a deliberate feature ("draft me something about just this theme").
 * Nothing behind it was removed — the Edge Function still accepts
 * `kind: "per_cluster"`, the RPCs still work, and every row it ever produced is
 * still in the database. Setting this to `true` restores the UI as it was.
 *
 * Turning it back on also means revisiting the Review and Export filters, which
 * hide per-cluster results while this is false.
 */
export const PER_CLUSTER_GENERATION = false

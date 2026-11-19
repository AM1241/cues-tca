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

/**
 * The new layout of 2026-11-17 (step strip, working period, Rating/Topics/Review
 * reorganised around each post's journey — TCA_TRIAL_HANDOFF.md §9.6).
 *
 * The operator asked that the old version be kept so that we can go back to it.
 * There are three ways, smallest first:
 *   1. In the app: "switch to the classic screens" at the bottom of every page.
 *      Per browser, nothing to deploy.
 *   2. For everyone: set this to `false` and deploy. The classic screens come
 *      back exactly as they were and the switch disappears. The new files stay
 *      in the tree, unused.
 *   3. In git: the tag `pre-ui-post-journey` is the code before any of this.
 */
export const NEW_LAYOUT = true

/**
 * The Legacy tabs in Review and Export (both layouts): the 15 texts migrated
 * from the pre-cloud system (`editorial_assets`, all `is_legacy`; 9 of them are
 * the old tool's simulated fallback, not AI output). Nothing in the current
 * pipeline writes there.
 *
 * Hidden on 2026-11-19 at the operator's request: in the call of 2026-11-06 the
 * tab was taken for "earlier carousel versions", and it is of no use to the
 * partner. Only the tabs are hidden — the rows stay in the database, and setting
 * this to `true` and deploying brings the tabs back as they were.
 */
export const SHOW_LEGACY = false

/**
 * Scoring prompt + JSON schema, built dynamically from a scoring_request's
 * config_snapshot. Ported from the legacy per-theme rubric in the dead
 * `llm_batch_scoring_service.py` (the live system used a bare-integer prompt,
 * which is why every migrated analysis has flat 0.0 per-theme scores).
 *
 * The worker never hardcodes the theme list — it always comes from the
 * request's snapshot, so scoring_themes can change without touching this file.
 */
import type { JsonSchemaFormat } from "../_shared/openai.ts";

export interface ThemeSnapshotEntry {
  theme_id: string;
  label: string;
  position: number;
}

export interface ScoringPost {
  sourceName: string;
  postId: string;
  text: string;
}

export function buildScoringPrompt(post: ScoringPost, themes: ThemeSnapshotEntry[]): string {
  const themesBlock = themes.map((t) => `- ${t.theme_id} (${t.label})`).join("\n");
  return (
    "You are scoring LinkedIn posts for the CUES editorial pipeline.\n\n" +
    "Score how relevant this post is to each editorial theme below.\n\n" +
    `Themes:\n${themesBlock}\n\n` +
    "Scoring rubric (apply per theme):\n" +
    "0-20 = unrelated noise or pure marketing\n" +
    "21-40 = weak or indirect relevance\n" +
    "41-60 = partial relevance with some editorial value\n" +
    "61-80 = strong relevance to food, agriculture, sustainability, supply chain, innovation, or talent\n" +
    "81-100 = direct high-value relevance with clear editorial usefulness\n\n" +
    "Rules:\n" +
    "- Score every theme independently as an integer from 0 to 100.\n" +
    "- Include every listed theme_id in theme_scores, using the exact theme_id given.\n" +
    "- Be conservative and context-aware; do not inflate scores for marketing language.\n" +
    "- reason is a short explanation (1-2 sentences) of the overall editorial relevance.\n\n" +
    `Source: ${post.sourceName}\n` +
    `Post ID: ${post.postId}\n\n` +
    `POST TEXT:\n${post.text}`
  );
}

/** Strict JSON schema for the Responses API — every theme_id is a required key. */
export function buildScoringSchema(themes: ThemeSnapshotEntry[]): JsonSchemaFormat {
  const themeProps: Record<string, unknown> = {};
  for (const t of themes) {
    themeProps[t.theme_id] = { type: "integer", minimum: 0, maximum: 100 };
  }
  return {
    name: "scoring_result",
    schema: {
      type: "object",
      properties: {
        theme_scores: {
          type: "object",
          properties: themeProps,
          required: themes.map((t) => t.theme_id),
          additionalProperties: false,
        },
        reason: { type: "string" },
      },
      required: ["theme_scores", "reason"],
      additionalProperties: false,
    },
  };
}

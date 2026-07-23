/**
 * Scoring prompt + JSON schema.
 *
 * The prompt TEXT is not defined here — it is the immutable `prompt_template`
 * stored on the scoring_request (migration 0010, source
 * `public.scoring_prompt_template()`), so a historical result can always be
 * reproduced from its request row and a later template edit is distinguishable
 * from the one actually used. This file only *renders* that template by
 * substituting the placeholders, and derives the JSON schema from the request's
 * theme snapshot (the theme list is never hardcoded either).
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

/**
 * Render the request's stored template. Placeholders: {{THEMES}} (the theme
 * list), {{SOURCE}}, {{POST_ID}}, {{POST_TEXT}}. Substitution is literal — no
 * placeholder in the template body can be forged from post text, since post
 * text is only ever the replacement value, never the pattern.
 */
export function buildScoringPrompt(
  template: string,
  post: ScoringPost,
  themes: ThemeSnapshotEntry[],
): string {
  const themesBlock = themes.map((t) => `- ${t.theme_id} (${t.label})`).join("\n");
  return template
    .replaceAll("{{THEMES}}", themesBlock)
    .replaceAll("{{SOURCE}}", post.sourceName)
    .replaceAll("{{POST_ID}}", post.postId)
    .replaceAll("{{POST_TEXT}}", post.text);
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

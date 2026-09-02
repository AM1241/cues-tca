/**
 * Generation prompt — one structured LLM call per selected cluster, returning
 * both the post and the carousel draft together. Ported in spirit from
 * ../../../cues-tca-editorial-agent/backend/app/services/
 * llm_editorial_generation_service.py (the editorial-brief + voice + cluster-
 * evidence prompt shape), but using this project's structured JSON-schema
 * output convention (see cluster/prompt.ts) instead of markdown parsing.
 *
 * The prompt consumes ONLY anonymised post text (anonymize_results.
 * anonymized_text) — never raw_posts.post_text — and explicitly instructs the
 * model not to reintroduce any identity the anonymisation step removed.
 */
import type { JsonSchemaFormat } from "../_shared/openai.ts";
import type { GenerationConfigRow } from "./data.ts";

export const PROMPT_VERSION = "generate_v3";

/**
 * Fallback brief, derived from the operator's editorial_domain rather than
 * naming a sector. The old constant hardcoded "food-industry organisations",
 * which was one of the four things that made this tool silently food-only —
 * pointed at another sector it kept writing for food. See
 * 0019_editorial_domain.sql. `voice_style` still overrides this entirely.
 */
function defaultBrief(domain: string): string {
  return (
    `This publication covers ${domain}. Highlight how organisations in that sector ` +
    "communicate change, value, and responsibility, and give the institutional and " +
    "policy context that surrounds them."
  );
}

const MAX_POSTS = 12;
const MAX_CHARS_PER_POST = 500;

/**
 * What an editor asked for after reading a draft. `previous` is the draft they
 * were looking at — without it "make it sharper" refers to nothing, and the
 * model would simply produce another first attempt.
 *
 * `feedback` is optional on purpose: pressing Regenerate with no note is a
 * legitimate request for a different take on the same evidence, and the two
 * cases need different instructions. A note says what to change; no note says
 * change the angle.
 */
export interface RevisionContext {
  feedback: string | null;
  previousOutputType: "post" | "carousel";
  previousOutput: unknown;
}

function buildRevisionBlock(revision: RevisionContext): string {
  const note = revision.feedback?.trim() ?? "";
  const instruction = note
    ? [
      "The editor read that draft and asked for this:",
      "",
      note,
      "",
      "Produce a new version that answers the instruction. Keep what already worked; change",
      "what was asked for. Do not restate the instruction in the copy.",
    ].join("\n")
    : [
      "The editor asked for a different take, without saying what was wrong. Produce a",
      "materially different version — a different angle or structure on the same evidence —",
      "not a paraphrase of the draft above.",
    ].join("\n");

  return `

You have already produced a draft for this cluster. This is a revision, not a first attempt.

Previous ${revision.previousOutputType} draft:
${JSON.stringify(revision.previousOutput, null, 2)}

${instruction}

Every rule below still applies to the new version.`;
}

export interface GenerationInputPost {
  anonymized_text: string;
  generalized_source_name: string;
}

function buildEvidenceBlock(posts: GenerationInputPost[]): string {
  return posts.slice(0, MAX_POSTS)
    .map((p, i) => `${i + 1}. [${p.generalized_source_name}] ${p.anonymized_text.slice(0, MAX_CHARS_PER_POST)}`)
    .join("\n\n");
}

function themesToText(themes: unknown): string {
  if (!Array.isArray(themes) || themes.length === 0) return "";
  const labels = themes
    .map((t) => (typeof t === "string" ? t : (t as { label?: string })?.label))
    .filter((l): l is string => typeof l === "string" && l.length > 0);
  return labels.length ? `Configured editorial themes: ${labels.join(", ")}.` : "";
}

export function buildGenerationPrompt(
  clusterLabel: string,
  posts: GenerationInputPost[],
  config: GenerationConfigRow,
  revision?: RevisionContext,
): string {
  const domain = config.editorial_domain?.trim() || "its editorial domain";
  // The example given to the model must be the wording the anonymiser actually
  // produced, or the instruction points at a string that is not in the evidence.
  const genericEntity = config.domain_generic_entity?.trim() || "a generic organization";
  const brief = config.voice_style?.trim() || defaultBrief(domain);
  const tone = config.voice_tone?.trim() || "objective, insight-driven, professional but accessible";
  const audience = config.voice_audience?.trim() || `senior decision-makers in ${domain}`;
  const themesLine = themesToText(config.themes);
  const evidence = buildEvidenceBlock(posts);

  return `You are an editorial strategist producing LinkedIn content about ${domain}.

Editorial brief:
${brief}
${themesLine ? `\n${themesLine}\n` : ""}
Voice: ${tone}
Audience: ${audience}

Cluster theme: "${clusterLabel}"

Anonymised source posts for this cluster (already anonymised — company and person names have
already been replaced with generic descriptions):
${evidence}
${revision ? buildRevisionBlock(revision) : ""}

Produce BOTH a LinkedIn post draft and a 5-slide LinkedIn carousel draft from this cluster's
evidence, following the required structured output schema exactly.

Carousel slide structure, in order:
1. Opening/title slide
2. Context/problem slide
3. Main insight slide
4. Evidence/implication slide
5. Closing/CTA slide

Rules:
- Do not mention any specific company, brand, or person name. The source posts have already been
  anonymised — do not attempt to infer, guess, or reintroduce any real identity that was removed;
  refer only to the generic descriptions already present in the evidence (e.g. "${genericEntity}").
- Write in English.
- Ground every claim in the evidence provided; do not invent facts not supported by it.
- Use short paragraphs, a clear structure, and a publication-ready tone.
- Keep the editorial voice strong, purposeful, and insight-driven; connect the cluster's posts
  into one coherent narrative rather than listing them.
- The post's hashtags must be relevant to the cluster's theme, without any identifying names.`;
}

export function buildGenerationSchema(): JsonSchemaFormat {
  return {
    name: "cluster_generation_result",
    schema: {
      type: "object",
      properties: {
        post: {
          type: "object",
          properties: {
            headline: { type: "string" },
            text: { type: "string" },
            cta: { type: "string" },
            hashtags: { type: "array", items: { type: "string" } },
          },
          required: ["headline", "text", "cta", "hashtags"],
          additionalProperties: false,
        },
        carousel: {
          type: "object",
          properties: {
            title: { type: "string" },
            slides: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  position: { type: "integer" },
                  heading: { type: "string" },
                  body: { type: "string" },
                },
                required: ["position", "heading", "body"],
                additionalProperties: false,
              },
            },
            caption: { type: "string" },
            cta: { type: "string" },
          },
          required: ["title", "slides", "caption", "cta"],
          additionalProperties: false,
        },
      },
      required: ["post", "carousel"],
      additionalProperties: false,
    },
  };
}

export interface ParsedGenerationOutput {
  post: {
    headline: string;
    text: string;
    cta: string;
    hashtags: string[];
  };
  carousel: {
    title: string;
    slides: { position: number; heading: string; body: string }[];
    caption: string;
    cta: string;
  };
}

/** Validates the parsed JSON has the exact shape the API contract promises (5 slides, positions 1-5). */
export function validateGenerationOutput(parsed: Record<string, unknown>): ParsedGenerationOutput {
  const post = parsed.post as Record<string, unknown> | undefined;
  const carousel = parsed.carousel as Record<string, unknown> | undefined;
  if (!post || typeof post.headline !== "string" || typeof post.text !== "string" ||
    typeof post.cta !== "string" || !Array.isArray(post.hashtags)) {
    throw new Error("generation output missing a valid post object");
  }
  if (!carousel || typeof carousel.title !== "string" || !Array.isArray(carousel.slides) ||
    typeof carousel.caption !== "string" || typeof carousel.cta !== "string") {
    throw new Error("generation output missing a valid carousel object");
  }
  const slides = carousel.slides as Record<string, unknown>[];
  if (slides.length !== 5) {
    throw new Error(`generation output carousel must have exactly 5 slides, got ${slides.length}`);
  }
  const normalizedSlides = slides.map((s, i) => {
    if (typeof s.heading !== "string" || typeof s.body !== "string") {
      throw new Error(`generation output carousel slide ${i + 1} missing heading/body`);
    }
    return { position: i + 1, heading: s.heading, body: s.body };
  });

  return {
    post: {
      headline: post.headline as string,
      text: post.text as string,
      cta: post.cta as string,
      hashtags: (post.hashtags as unknown[]).filter((h): h is string => typeof h === "string"),
    },
    carousel: {
      title: carousel.title as string,
      slides: normalizedSlides,
      caption: carousel.caption as string,
      cta: carousel.cta as string,
    },
  };
}

/**
 * Prompts for carousel slide BACKGROUNDS.
 *
 * The model is never asked to render the slide's words. The words are drawn by
 * frontend/src/lib/slides.ts from the approved output, character for character,
 * for the reason set out at the top of that file: an image model that garbles
 * text turns "approved in Review" into "something else on LinkedIn", silently.
 * What is asked for here is the picture behind them.
 *
 * Three constraints do the real work, and each exists because of a specific way
 * this goes wrong:
 *
 *   1. NO TEXT ANYWHERE. Image models volunteer signage, captions and
 *      watermarks unless told repeatedly not to. Any of it lands underneath our
 *      own typography and reads as a printing error.
 *   2. DARK AND LOW-KEY. The compositor lays a scrim over this and then white
 *      text over that. A bright image forces the scrim heavy enough to erase
 *      the picture entirely — which is exactly what the first version did.
 *   3. QUIET ON THE LEFT. Every slide's heading and body sit in the left
 *      column. Composition is the only thing that keeps a busy subject from
 *      colliding with them, since the text position is fixed.
 *
 * Two further rules follow from the rest of the pipeline rather than from
 * design. No recognisable people: the corpus is anonymised, and a face is an
 * identity. No logos or branded packaging: the anonymiser spends its whole
 * existence removing company identity from the words, and restoring it in the
 * picture would be absurd.
 */

/** Snapshot pinned like every other model in this project — see score-worker. */
export const IMAGE_MODEL = "gpt-image-2-2026-04-21";
export const IMAGE_PROMPT_VERSION = "slide_background_v1";

/**
 * Both edges must be divisible by 16 (API rule), so the slide's own 1080 is not
 * requestable. 1024 is the nearest standard square; the compositor cover-fits,
 * so the 5% upscale is invisible.
 */
export const IMAGE_SIZE = "1024x1024";

/**
 * Shared across every slide in one carousel. Without a fixed style the seven
 * images come back in seven unrelated visual languages, which reads as a
 * mistake rather than a set — the single most obvious failure mode when each
 * slide is prompted independently.
 */
const STYLE_DIRECTIVE = [
  "Style: abstract editorial photography, shallow depth of field, soft natural light,",
  "muted desaturated palette of deep greens, slate blues and warm earth tones.",
  "Low-key and dark overall, as if underexposed by one stop. Fine organic texture.",
  "No illustration, no 3D render, no infographic, no diagram.",
].join(" ");

const HARD_CONSTRAINTS = [
  "Absolutely no text, letters, words, numbers, captions, labels, signage, watermarks,",
  "logos, brand marks or typography of any kind anywhere in the image.",
  "No recognisable people, no faces, no branded packaging.",
  "Composition must keep the left half and the top and bottom edges visually calm and dark —",
  "uncluttered negative space with no focal detail — because text is placed there afterwards.",
  "Put any subject interest in the middle-right of the frame.",
].join(" ");

export interface SlideForImage {
  position: number
  heading: string
  body: string
}

/** Keeps a runaway slide from dominating the prompt; the mood is what matters. */
const MAX_SUBJECT_CHARS = 320;

function subjectFrom(slide: SlideForImage): string {
  const text = `${slide.heading.trim()}. ${slide.body.trim()}`
    .replace(/\s+/g, " ")
    .slice(0, MAX_SUBJECT_CHARS);
  return text;
}

export interface BuildSlideImagePromptOptions {
  /** The publication's own domain, so the imagery sits in the right sector. */
  domain?: string;
  /** Operator override for STYLE_DIRECTIVE, when a house look is wanted. */
  styleOverride?: string | null;
}

export function buildSlideImagePrompt(
  slide: SlideForImage,
  opts: BuildSlideImagePromptOptions = {},
): string {
  const domain = opts.domain?.trim() || "the food and agriculture sector";
  const style = opts.styleOverride?.trim() || STYLE_DIRECTIVE;

  return [
    `A background image for a professional LinkedIn carousel slide about ${domain}.`,
    "",
    "Interpret this slide's meaning as mood and metaphor — an atmosphere, a material, a",
    "landscape or a texture that evokes it. Do not illustrate it literally and do not",
    "depict its words:",
    `"${subjectFrom(slide)}"`,
    "",
    style,
    "",
    HARD_CONSTRAINTS,
  ].join("\n");
}

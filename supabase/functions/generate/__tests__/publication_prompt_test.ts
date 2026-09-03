/**
 * Offline tests for the publication prompt and validator (0024). No database,
 * no OpenAI.
 *
 * What is worth pinning here is the difference from the per-cluster prompt.
 * A publication that quietly drops a theme still reads like a finished piece —
 * nothing about the copy announces that one of the operator's selected themes
 * never made it in. The slide-count assertion is the only thing standing
 * between that and an editor shipping it.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  buildPublicationPrompt,
  MAX_PUBLICATION_THEMES,
  type PublicationTheme,
  type RevisionContext,
  validatePublicationOutput,
} from "../prompt.ts";
import type { GenerationConfigRow } from "../data.ts";

const config: GenerationConfigRow = {
  themes: [{ theme_id: "traceability", label: "traceability" }],
  voice_tone: "objective",
  voice_audience: "senior decision-makers",
  voice_style: null,
  editorial_domain: "food, agriculture and the agrifood supply chain",
  domain_generic_entity: "a food-sector organization",
};

const period = { start: "2026-08-20T00:00:00.000Z", end: "2026-09-03T00:00:00.000Z" };

const themes: PublicationTheme[] = [
  {
    label: "Traceability builds trust",
    posts: [{
      anonymized_text: "a food-sector organization published its supply-chain audit.",
      generalized_source_name: "a food-sector organization",
    }],
  },
  {
    label: "Packaging that earns its place",
    posts: [{
      anonymized_text: "a food-sector organization cut packaging weight by a fifth.",
      generalized_source_name: "a food-sector organization",
    }],
  },
];

function slides(n: number) {
  return Array.from({ length: n }, (_, i) => ({ position: i + 1, heading: `h${i}`, body: `b${i}` }));
}

function output(slideCount: number): Record<string, unknown> {
  return {
    post: { headline: "H", text: "T", cta: "C", hashtags: ["#x"] },
    carousel: { title: "T", slides: slides(slideCount), caption: "c", cta: "c" },
  };
}

Deno.test("every selected theme appears in the prompt, in order", () => {
  const prompt = buildPublicationPrompt(themes, config, period);
  const first = prompt.indexOf("Traceability builds trust");
  const second = prompt.indexOf("Packaging that earns its place");
  assert(first > -1 && second > -1, "both theme labels must reach the model");
  assert(first < second, "themes must keep the order the caller chose");
});

Deno.test("the carousel is asked for as opening + themes + closing", () => {
  const prompt = buildPublicationPrompt(themes, config, period);
  // Two themes -> four slides. Stated as a number, because "one per theme" on
  // its own has let models return a tidy five.
  assertStringIncludes(prompt, "carousel of exactly 4 slides");
  assertStringIncludes(prompt, "1. Opening slide");
  assertStringIncludes(prompt, "4. Closing slide");
});

Deno.test("the period reaches the model as dates, not timestamps", () => {
  const prompt = buildPublicationPrompt(themes, config, period);
  assertStringIncludes(prompt, "Period covered: 2026-08-20 to 2026-09-03");
});

Deno.test("it asks for one story, not a bundle of separate ones", () => {
  const prompt = buildPublicationPrompt(themes, config, period);
  assertStringIncludes(prompt, "ONE LinkedIn post and ONE carousel");
  assertStringIncludes(prompt, "not 2 pieces joined together");
});

Deno.test("the anonymisation rule survives into the publication prompt", () => {
  const prompt = buildPublicationPrompt(themes, config, period);
  assertStringIncludes(prompt, "Do not mention any specific company, brand, or person name");
  assertStringIncludes(prompt, "a food-sector organization");
});

Deno.test("a first-pass publication says nothing about revising", () => {
  const prompt = buildPublicationPrompt(themes, config, period);
  assert(!prompt.includes("This is a revision"));
});

Deno.test("a publication revision carries the previous draft and the note", () => {
  const revision: RevisionContext = {
    feedback: "Too soft. Lead with enforcement.",
    previousOutputType: "post",
    previousOutput: { headline: "Quietly", text: "t", cta: "c", hashtags: [] },
  };
  const prompt = buildPublicationPrompt(themes, config, period, revision);
  assertStringIncludes(prompt, "This is a revision, not a first attempt");
  assertStringIncludes(prompt, "Too soft. Lead with enforcement.");
  assertStringIncludes(prompt, "Quietly");
  // The evidence must still be there — a revision is not a rewrite from memory.
  assertStringIncludes(prompt, "published its supply-chain audit");
});

Deno.test("the validator accepts exactly opening + themes + closing", () => {
  const parsed = validatePublicationOutput(output(4), 4);
  assertEquals(parsed.carousel.slides.length, 4);
  assertEquals(parsed.carousel.slides.map((s) => s.position), [1, 2, 3, 4]);
});

Deno.test("a dropped theme is rejected, not published", () => {
  // Three slides where four were asked for: one theme silently vanished.
  const err = assertThrows(() => validatePublicationOutput(output(3), 4), Error);
  assertStringIncludes(err.message, "exactly 4 slides");
  assertStringIncludes(err.message, "got 3");
});

Deno.test("an over-long carousel is rejected too", () => {
  assertThrows(() => validatePublicationOutput(output(9), 4), Error, "exactly 4 slides");
});

Deno.test("slide positions are renumbered, never trusted from the model", () => {
  const bad = output(4);
  // deno-lint-ignore no-explicit-any
  (bad.carousel as any).slides = [
    { position: 9, heading: "a", body: "a" },
    { position: 9, heading: "b", body: "b" },
    { position: 1, heading: "c", body: "c" },
    { position: 4, heading: "d", body: "d" },
  ];
  const parsed = validatePublicationOutput(bad, 4);
  assertEquals(parsed.carousel.slides.map((s) => s.position), [1, 2, 3, 4]);
  assertEquals(parsed.carousel.slides.map((s) => s.heading), ["a", "b", "c", "d"]);
});

Deno.test("a missing post object fails rather than shipping half a publication", () => {
  const bad = output(4);
  delete bad.post;
  assertThrows(() => validatePublicationOutput(bad, 4), Error, "missing a valid post object");
});

Deno.test("the theme cap is low enough to keep a carousel readable", () => {
  // 2 + MAX must stay within the ten slides LinkedIn carousels are read at.
  assert(MAX_PUBLICATION_THEMES + 2 <= 10, "carousel would exceed ten slides");
});

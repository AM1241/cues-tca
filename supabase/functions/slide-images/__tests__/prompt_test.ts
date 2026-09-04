/**
 * Pure tests for the slide-background prompt and the Images API client.
 * No network, no database, no key — run with:
 *   deno test --allow-env slide-images/__tests__/prompt_test.ts
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { buildSlideImagePrompt, IMAGE_SIZE } from "../prompt.ts";
import { stripImageBytes } from "../../_shared/openai_images.ts";

const SLIDE = {
  position: 3,
  heading: "Sustainability needs solutions",
  body: "Circular economy, bioplastics and regenerative agriculture turn sustainability from a promise into practical action.",
};

Deno.test("[slide-images prompt] forbids text in the image, in the terms models actually add it", () => {
  const p = buildSlideImagePrompt(SLIDE);
  // Each of these is a real thing image models volunteer unprompted, and each
  // would land underneath the typography the compositor draws.
  for (const banned of ["text", "letters", "words", "numbers", "captions", "signage", "watermarks", "logos", "typography"]) {
    assertStringIncludes(p.toLowerCase(), banned);
  }
});

Deno.test("[slide-images prompt] reserves the left column and the edges for the text", () => {
  const p = buildSlideImagePrompt(SLIDE).toLowerCase();
  assertStringIncludes(p, "left half");
  assertStringIncludes(p, "middle-right");
});

Deno.test("[slide-images prompt] asks for a dark, low-key image so the scrim stays light", () => {
  // The compositor darkens whatever comes back. A bright image forces a heavy
  // scrim, which erases the picture — the exact failure the first attempt hit.
  assertStringIncludes(buildSlideImagePrompt(SLIDE).toLowerCase(), "low-key and dark");
});

Deno.test("[slide-images prompt] rules out faces and branding, consistent with the anonymiser", () => {
  const p = buildSlideImagePrompt(SLIDE).toLowerCase();
  assertStringIncludes(p, "no recognisable people");
  assertStringIncludes(p, "no branded packaging");
});

Deno.test("[slide-images prompt] tells the model to read the slide as mood, not to render it", () => {
  const p = buildSlideImagePrompt(SLIDE);
  // The slide text is present as SUBJECT MATTER — that is intended, it is what
  // makes each background belong to its slide. What must never appear is an
  // instruction to draw it.
  assertStringIncludes(p, SLIDE.heading);
  assertStringIncludes(p, "Do not illustrate it literally and do not");
  assertStringIncludes(p, "depict its words");
});

Deno.test("[slide-images prompt] carries the configured domain, and falls back when it is blank", () => {
  assertStringIncludes(buildSlideImagePrompt(SLIDE, { domain: "marine logistics" }), "marine logistics");
  assertStringIncludes(buildSlideImagePrompt(SLIDE, { domain: "   " }), "food and agriculture");
});

Deno.test("[slide-images prompt] truncates a runaway slide instead of sending it whole", () => {
  const long = { position: 2, heading: "H".repeat(500), body: "B".repeat(4000) }
  const p = buildSlideImagePrompt(long)
  assert(p.length < 2_000, `prompt should stay bounded, got ${p.length} chars`)
});

Deno.test("[slide-images prompt] every slide of a carousel shares one style directive", () => {
  // Seven independently-styled images read as a mistake rather than a set.
  const a = buildSlideImagePrompt({ position: 1, heading: "One", body: "First." })
  const b = buildSlideImagePrompt({ position: 7, heading: "Seven", body: "Last." })
  const styleLine = "Style: abstract editorial photography"
  assertStringIncludes(a, styleLine)
  assertStringIncludes(b, styleLine)
});

Deno.test("[slide-images] the requested size has both edges divisible by 16", () => {
  // The API rejects anything else, and the slide's own 1080 is not a legal
  // value — this is why the compositor cover-fits rather than matching exactly.
  const [w, h] = IMAGE_SIZE.split("x").map(Number);
  assertEquals(w % 16, 0);
  assertEquals(h % 16, 0);
});

Deno.test("[slide-images] stripImageBytes removes the megabytes but keeps the audit fields", () => {
  const raw = {
    created: 1,
    data: [{ b64_json: "A".repeat(5000), revised_prompt: "a dark field" }],
    usage: { total_tokens: 42 },
  };
  const stripped = stripImageBytes(raw) as Record<string, never>;
  const entry = (stripped.data as unknown as Record<string, unknown>[])[0];
  assertEquals(entry.b64_json, undefined, "the image bytes must not survive into a stored record");
  assertEquals(entry.b64_json_bytes, 5000, "but their size is worth keeping");
  assertEquals(entry.revised_prompt, "a dark field");
  assertEquals((stripped as Record<string, unknown>).usage, { total_tokens: 42 });
});

Deno.test("[slide-images] stripImageBytes is inert on shapes it does not recognise", () => {
  assertEquals(stripImageBytes(null), null);
  assertEquals(stripImageBytes({ error: "nope" }), { error: "nope" });
});

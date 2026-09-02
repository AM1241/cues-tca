/**
 * Offline tests for the generation prompt. No database, no OpenAI.
 *
 * The revision block (0023) is the part worth pinning: a regeneration whose
 * prompt does not actually carry the previous draft is indistinguishable from
 * a first attempt, and the editor would press Regenerate, pay for a call, and
 * get the same copy back with no way to tell why.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { buildGenerationPrompt, type RevisionContext } from "../prompt.ts";
import type { GenerationConfigRow } from "../data.ts";

const config: GenerationConfigRow = {
  themes: [{ theme_id: "sustainability", label: "sustainability" }],
  voice_tone: "objective",
  voice_audience: "senior decision-makers",
  voice_style: null,
  editorial_domain: "food, agriculture and the agrifood supply chain",
  domain_generic_entity: "a food-sector organization",
};

const posts = [
  { anonymized_text: "a food-sector organization cut water use.", generalized_source_name: "a food-sector organization" },
];

const previousPost = {
  headline: "Water, quietly",
  text: "The sector is reducing consumption.",
  cta: "What is your baseline?",
  hashtags: ["#water"],
};

Deno.test("a first-pass prompt says nothing about revising", () => {
  const prompt = buildGenerationPrompt("water use", posts, config);
  assert(!prompt.includes("This is a revision"));
  assert(!prompt.includes("Previous"));
});

Deno.test("a revision carries the previous draft and the editor's words", () => {
  const revision: RevisionContext = {
    feedback: "Too corporate. Lead with the policy angle.",
    previousOutputType: "post",
    previousOutput: previousPost,
  };
  const prompt = buildGenerationPrompt("water use", posts, config, revision);

  assertStringIncludes(prompt, "This is a revision, not a first attempt.");
  assertStringIncludes(prompt, "Previous post draft:");
  // The draft itself, not a description of it.
  assertStringIncludes(prompt, "Water, quietly");
  assertStringIncludes(prompt, "Too corporate. Lead with the policy angle.");
});

Deno.test("no note asks for a different angle rather than a paraphrase", () => {
  // Pressing Regenerate with an empty box is a real request — "give me
  // another take" — and must not degrade into repeating the same draft.
  const prompt = buildGenerationPrompt("water use", posts, config, {
    feedback: null,
    previousOutputType: "post",
    previousOutput: previousPost,
  });
  assertStringIncludes(prompt, "materially different version");
  assert(!prompt.includes("The editor read that draft and asked for this:"));
});

Deno.test("whitespace-only feedback is treated as no feedback", () => {
  const prompt = buildGenerationPrompt("water use", posts, config, {
    feedback: "   \n  ",
    previousOutputType: "post",
    previousOutput: previousPost,
  });
  assertStringIncludes(prompt, "materially different version");
});

Deno.test("a carousel revision names the carousel", () => {
  const prompt = buildGenerationPrompt("water use", posts, config, {
    feedback: "Slide 3 is weak.",
    previousOutputType: "carousel",
    previousOutput: { title: "Water", slides: [], caption: "c", cta: "x" },
  });
  assertStringIncludes(prompt, "Previous carousel draft:");
});

Deno.test("the anonymisation rules still apply to a revision", () => {
  // The revision block is inserted BEFORE the rules; if it ever landed after
  // them, the model would be told to revise and then never told the
  // constraints. This is the cheap check that the order holds.
  const prompt = buildGenerationPrompt("water use", posts, config, {
    feedback: "Sharper.",
    previousOutputType: "post",
    previousOutput: previousPost,
  });
  assert(prompt.indexOf("This is a revision") < prompt.indexOf("Do not mention any specific company"));
  assertStringIncludes(prompt, "Every rule below still applies to the new version.");
});

Deno.test("the previous draft does not displace the evidence", () => {
  const prompt = buildGenerationPrompt("water use", posts, config, {
    feedback: "Sharper.",
    previousOutputType: "post",
    previousOutput: previousPost,
  });
  assertStringIncludes(prompt, "a food-sector organization cut water use.");
  assertEquals(prompt.includes("Anonymised source posts for this cluster"), true);
});

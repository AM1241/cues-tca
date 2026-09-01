/**
 * Brand-discovery prompt — one structured call per source.
 *
 * The anonymiser can only derive names from a source's label. This asks the
 * model to read the source's own posts and name everything ELSE that identifies
 * the same company: product brands, historical names, subsidiaries, venues.
 *
 * The prompt's real work is pushing AGAINST category words. A model asked for
 * "names associated with this company" will happily return "vermouth" and
 * "amaro" — and an alias list containing those turns every mention of the
 * product into "a food-sector organization", which destroys the copy the
 * generator later reads. Missing a brand costs one more review round; a
 * category in the list is not noticed until the output is nonsense.
 */
import type { JsonSchemaFormat } from "../_shared/openai.ts";

const MAX_POSTS = 25;
const MAX_CHARS_PER_POST = 600;

export interface DiscoveryPost {
  text: string;
}

export function buildDiscoveryPrompt(
  sourceLabel: string,
  domain: string,
  posts: DiscoveryPost[],
  knownNames: string[],
): string {
  const evidence = posts.slice(0, MAX_POSTS)
    .map((p, i) => `${i + 1}. ${p.text.slice(0, MAX_CHARS_PER_POST)}`)
    .join("\n\n");

  const known = knownNames.length
    ? `\nAlready known, do not repeat these:\n${knownNames.map((n) => `- ${n}`).join("\n")}\n`
    : "";

  return `These posts were all published by one organisation on LinkedIn, in the ${domain} sector.

Its catalogue label is: "${sourceLabel}"

Your task: list the names appearing in these posts that would IDENTIFY this
specific organisation to a reader. An editorial pipeline replaces such names with
a generic description so its commentary is about the sector rather than about one
company, and it can only derive forms of the label above — everything else has to
come from you.

Include:
- product or sub-brand names owned by this organisation
- historical or former names of it or its products
- subsidiaries, divisions, and named venues it owns (a museum, a distillery, a foundation)
- distinctive family or founder surnames used as the company's identity

Do NOT include:
- product categories or generic descriptors — vermouth, amaro, pasta, olive oil,
  sparkling water. These describe what is sold, not who sells it, and removing
  them would make the text meaningless.
- places, cities, or regions
- public institutions, ministries, agencies or regulators
- other companies merely mentioned, partnered with, or reported on
- job titles, people who merely appear, or event and campaign slogans

A name written as a hashtag still counts, and some brands appear only ever as
hashtags — go through the hashtags explicitly rather than skimming past them.
Judge each by what the surrounding sentence calls it. If a post reads
"i nostri marchi iconici, tra cui #Alfa e #Beta", then Alfa and Beta are owned
brands and belong in your list; "#WeAreProud" is a slogan and does not.
- the catalogue label itself or its obvious word-for-word parts
${known}
Be conservative. A name you are unsure about is better left out: a human reviews
this list, and a wrong entry silently corrupts every future post.

For each name give a one-sentence rationale saying how the posts show it belongs
to this organisation. Return an empty list if nothing qualifies.

Posts:
${evidence}`;
}

export function buildDiscoverySchema(): JsonSchemaFormat {
  return {
    name: "brand_discovery_result",
    schema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["name", "rationale"],
            additionalProperties: false,
          },
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
  };
}

export interface DiscoveredName {
  name: string;
  rationale: string;
}

/** Validates the parsed JSON has the shape the schema promises. */
export function parseDiscoveryOutput(parsed: Record<string, unknown>): DiscoveredName[] {
  const names = parsed.names;
  if (!Array.isArray(names)) throw new Error("discovery output has no names array");
  return names
    .map((n) => n as Record<string, unknown>)
    .filter((n) => typeof n?.name === "string" && typeof n?.rationale === "string")
    .map((n) => ({ name: (n.name as string).trim(), rationale: (n.rationale as string).trim() }))
    .filter((n) => n.name.length > 0);
}

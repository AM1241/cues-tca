/**
 * LLM entity-extraction pass — closes the known legacy gap where a company
 * named in body text but not matching the source name survives
 * un-anonymised (docs/legacy-system.md §3, PHASE4_REQUIREMENTS.md §1).
 *
 * Unlike scoring's prompt (prompt.ts), there is no "immutable request"
 * concept for anonymisation (see 0014's migration header) — no per-request
 * stored template to render from. The template is a versioned constant
 * here; each anonymize_results row records its config_snapshot, so a
 * mismatch between "prompt at the time" and "prompt now" is at least
 * inspectable via config_hash, even without a stored template column.
 */
import type { JsonSchemaFormat } from "../_shared/openai.ts";

export const ENTITY_PROMPT_VERSION = "entity_extraction_v2";

const TEMPLATE = `You are identifying COMPANY names in a LinkedIn post that must be hidden before
the text is reused as editorial commentary. The post's own source, "{{SOURCE}}", has
already been handled separately — do not report it again.

Report a name ONLY if it identifies a specific private company or brand: a business,
its products, its subsidiaries.

Do NOT report — every one of these was wrongly reported in a real run and damaged
the text:

- Public institutions of any kind: ministries, agencies, regulators, chambers,
  inspectorates, police and military corps, EU and UN bodies, research institutes,
  public programmes and funding schemes. These are preserved on purpose.
- Trade fairs, exhibitions, conferences, awards and events.
- Generic phrases and category nouns, even capitalised: "Made in Italy",
  "trade associations", "protection consortia", "cocktail pairing".
- Places: countries, regions, cities.
- People's names.
- Amounts of money, dates, quantities.

If you are unsure whether something is a private company, leave it out. A missed
company can be added by an operator; a wrongly reported one silently rewrites the
meaning of the text and nobody notices.

Report the exact substring as it appears in the text. Return an empty list if there
are no private companies other than the source.

Text:
{{POST_TEXT}}`;

export function buildEntityExtractionPrompt(sourceName: string, postText: string): string {
  return TEMPLATE
    .replaceAll("{{SOURCE}}", sourceName)
    .replaceAll("{{POST_TEXT}}", postText);
}

export function buildEntityExtractionSchema(): JsonSchemaFormat {
  return {
    name: "entity_extraction_result",
    schema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["entities"],
      additionalProperties: false,
    },
  };
}

export interface EntityExtractionResult {
  entities: string[];
}

export function parseEntityExtractionResult(parsed: Record<string, unknown>): EntityExtractionResult {
  const entities = parsed.entities;
  if (!Array.isArray(entities) || !entities.every((e) => typeof e === "string")) {
    throw new Error("entity extraction response did not match the expected schema");
  }
  return { entities };
}

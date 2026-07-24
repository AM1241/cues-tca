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

export const ENTITY_PROMPT_VERSION = "entity_extraction_v1";

const TEMPLATE = `You are identifying organisation names mentioned in a LinkedIn post that
should be anonymised for editorial use. The post's own source, "{{SOURCE}}", has
already been replaced separately — do not report it again.

Find any OTHER company or organisation name mentioned in the text below that is not
a public body (governments, EU institutions, UN agencies, regulators). For each one,
report the exact substring as it appears in the text.

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

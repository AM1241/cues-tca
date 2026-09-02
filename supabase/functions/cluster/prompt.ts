/**
 * Cluster-naming prompt — one LLM call per cluster, per MIGRATION_PLAN.md's
 * original sketch ("label clusters with one LLM call each"). Uses the raw
 * editorial brief (docs/editorial-brief.md) as the tone/direction guide, and
 * passes representative post text as the evidence the model names from.
 */
import type { JsonSchemaFormat } from "../_shared/openai.ts";

/**
 * The naming brief, built from the operator's configured scope.
 *
 * This was a hardcoded CUES/food paragraph — the fifth place the tool assumed a
 * food publication, and the one session 14 missed when it claimed the others
 * were all made configurable. Pointed at another sector, every cluster name was
 * still written for a food audience.
 */
function buildBrief(domain: string, themeLabels: string[]): string {
  const themes = themeLabels.length
    ? "The main directions are:\n" + themeLabels.map((t) => `- ${t}`).join("\n") + "\n\n"
    : "";
  return `This publication builds an editorial narrative around ${domain} — how organisations in that sector communicate change, value, and responsibility.

We want clusters that feel like real editorial themes. The naming should sound like something an editor would write after reading the posts, not like a technical label.

${themes}Use the posts themselves to decide the final title. The brief is only there to guide the tone and direction.`;
}

const MAX_REPRESENTATIVE_POSTS = 5;
const MAX_CHARS_PER_POST = 400;

export function buildClusterLabelPrompt(
  postTexts: string[],
  domain: string,
  themeLabels: string[],
): string {
  const representative = postTexts.slice(0, MAX_REPRESENTATIVE_POSTS)
    .map((t, i) => `${i + 1}. ${t.slice(0, MAX_CHARS_PER_POST)}`)
    .join("\n\n");

  return `${buildBrief(domain, themeLabels)}

Instructions:
- Read the cluster evidence below and infer the best natural editorial title.
- Keep titles short, clear, and human.
- Do not force identical wording across clusters.
- Make the title reflect the dominant editorial meaning of the posts.
- If the cluster is mixed, choose the strongest shared narrative.
- Avoid generic titles like "Cluster A" or "Topic 1".

Cluster evidence:
${representative}`;
}

export function buildClusterLabelSchema(): JsonSchemaFormat {
  return {
    name: "cluster_label_result",
    schema: {
      type: "object",
      properties: {
        label: { type: "string" },
      },
      required: ["label"],
      additionalProperties: false,
    },
  };
}

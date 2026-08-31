/**
 * Offline tests for what discovery is allowed to propose. No database, no
 * OpenAI.
 *
 * This filter is the safety boundary. Everything past it becomes a question put
 * to a human, and a human asked twenty questions stops reading them — so a
 * proposal that could never be right must not get that far. The public-body case
 * matters most: the pipeline deliberately preserves ministries, so offering one
 * is offering to break that on purpose.
 */
import { assertEquals } from "jsr:@std/assert@1.0.19";
import { filterProposals } from "../index.ts";
import { parseDiscoveryOutput } from "../prompt.ts";

const base = {
  sourceLabel: "Fratelli Branca Distillerie LinkedIn",
  knownAliases: [] as string[],
  alreadySuggested: [] as string[],
};
const p = (name: string) => ({ name, rationale: "because" });
const names = (r: { kept: { name: string }[] }) => r.kept.map((k) => k.name);

Deno.test("a genuine product brand survives", () => {
  const r = filterProposals([p("Carpano"), p("Fernet-Branca")], base);
  assertEquals(names(r), ["Carpano", "Fernet-Branca"]);
});

Deno.test("a public body is never proposed", () => {
  // Anonymisation preserves these on purpose; proposing one asks the operator
  // to undo that.
  const r = filterProposals([p("MASAF"), p("European Commission"), p("EFSA"), p("Carpano")], base);
  assertEquals(names(r), ["Carpano"]);
  assertEquals(r.skipped.map((s) => s.reason), ["public_body", "public_body", "public_body"]);
});

Deno.test("the source's own label is not proposed back", () => {
  const r = filterProposals([p("Fratelli Branca Distillerie LinkedIn")], base);
  assertEquals(names(r), []);
  assertEquals(r.skipped[0].reason, "source_label");
});

Deno.test("a name already in company_aliases is not proposed again", () => {
  const r = filterProposals([p("carpano"), p("Punt e Mes")], {
    ...base,
    knownAliases: ["Carpano"],
  });
  // Case-insensitive: the alias list is not a set of exact strings to a reader.
  assertEquals(names(r), ["Punt e Mes"]);
  assertEquals(r.skipped[0].reason, "already_alias");
});

Deno.test("a name already decided for this source is not proposed again", () => {
  // This is what makes a rejection permanent — 0020 keeps rejected rows for it.
  const r = filterProposals([p("Vermouth"), p("Museo Branca")], {
    ...base,
    alreadySuggested: ["vermouth"],
  });
  assertEquals(names(r), ["Museo Branca"]);
  assertEquals(r.skipped[0].reason, "already_suggested");
});

Deno.test("duplicates within one response collapse", () => {
  const r = filterProposals([p("Carpano"), p("CARPANO"), p(" carpano ")], base);
  assertEquals(names(r), ["Carpano"]);
});

Deno.test("blank names are dropped without being reported as skipped", () => {
  const r = filterProposals([p("   "), p("Carpano")], base);
  assertEquals(names(r), ["Carpano"]);
  assertEquals(r.skipped, []);
});

Deno.test("malformed model output does not reach the filter", () => {
  assertEquals(parseDiscoveryOutput({ names: [] }), []);
  assertEquals(
    parseDiscoveryOutput({ names: [{ name: "Carpano", rationale: "x" }, { name: 42 }] }),
    [{ name: "Carpano", rationale: "x" }],
  );
});

Deno.test("a response with no names array is rejected rather than treated as empty", () => {
  // Silently reading a broken response as "nothing found" would make a failed
  // call look like a clean source.
  let raised = false;
  try {
    parseDiscoveryOutput({ something_else: true });
  } catch {
    raised = true;
  }
  assertEquals(raised, true);
});

/**
 * Pure-function tests for the deterministic pass. No database, no OpenAI —
 * these run offline.
 *
 * Every case here is drawn from the first real Phase 4 execution against
 * cloud (two MASAF posts, 2026-07-24), which is what exposed the three
 * defects: years bucketed as magnitudes, comma decimals matched mid-number,
 * and Italian public bodies replaced despite keep_public_bodies.
 */
import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  applyDeterministicReplacement,
  bucketLargeNumbers,
  bucketPercentages,
  isPublicBody,
  sourceNameVariants,
} from "../deterministic.ts";

const generalize = (s: string) => bucketPercentages(bucketLargeNumbers(s));

Deno.test("years are not bucketed as magnitudes", () => {
  assertEquals(
    generalize("i risultati tra il 2021 e il 2025 e il Piano dei Controlli 2026"),
    "i risultati tra il 2021 e il 2025 e il Piano dei Controlli 2026",
  );
});

Deno.test("non-year large numbers are still bucketed", () => {
  assertEquals(generalize("fatturato di 45000 euro"), "fatturato di 40000-50000 euro");
  assertEquals(generalize("oltre 315000 controlli"), "oltre 300000-400000 controlli");
});

Deno.test("comma decimals bucket on the whole number, not the fraction", () => {
  assertEquals(generalize("crescita (+25,7%)"), "crescita (+20-30%)");
});

Deno.test("dot decimals keep working", () => {
  assertEquals(generalize("crescita del 37.5%"), "crescita del 30-40%");
});

Deno.test("integer percentages keep working", () => {
  assertEquals(generalize("quasi raddoppiati (+93%)"), "quasi raddoppiati (+90-100%)");
});

Deno.test("small plain numbers are untouched", () => {
  assertEquals(generalize("oltre 90 tonnellate di cereali"), "oltre 90 tonnellate di cereali");
});

Deno.test("isPublicBody matches Italian institutions by wording", () => {
  assertEquals(isPublicBody("Carabinieri per la Tutela Agroalimentare di Parma"), true);
  assertEquals(isPublicBody("AUSL"), true);
  assertEquals(isPublicBody("Ministero dell'Agricoltura"), true);
});

Deno.test("isPublicBody still matches the exact-name list", () => {
  assertEquals(isPublicBody("European Commission"), true);
  assertEquals(isPublicBody("EFSA"), true);
});

Deno.test("isPublicBody does not preserve private companies", () => {
  assertEquals(isPublicBody("Barilla"), false);
  assertEquals(isPublicBody("Ferrero S.p.A."), false);
  assertEquals(isPublicBody("GBfoods Italy"), false);
});

// The cases below are drawn from the first WIDENED run (49 posts,
// 2026-07-24), which leaked "GBfoods": stage 1 only matched the exact
// catalogue label "STAR / GBfoods Italy LinkedIn", and stage 2's prompt tells
// the model not to report the source's own name.

Deno.test("isPublicBody matches the institutions the widened run replaced", () => {
  assertEquals(isPublicBody("MASAF"), true);
  assertEquals(isPublicBody("UNESCO"), true);
  assertEquals(isPublicBody("Camera dei Deputati"), true);
  assertEquals(isPublicBody("Ismea"), true);
});

const cfg = { anonymizeCompanies: true, keepPublicBodies: true, companyAliases: {} };

Deno.test("catalogue labels expand to the forms used in body text", () => {
  assertEquals(sourceNameVariants("STAR / GBfoods Italy LinkedIn"), [
    "STAR / GBfoods Italy LinkedIn",
    "STAR / GBfoods Italy",
    "GBfoods Italy",
    "GBfoods",
    "STAR",
  ]);
});

Deno.test("short forms of the source name no longer survive stage 1", () => {
  const { text, replacements } = applyDeterministicReplacement(
    "Sustainability matters. GBfoods is committed to zero-waste manufacturing. STAR agrees.",
    "STAR / GBfoods Italy LinkedIn",
    cfg,
  );
  assertEquals(
    text,
    "Sustainability matters. a food-sector organization is committed to zero-waste manufacturing. a food-sector organization agrees.",
  );
  assertEquals(replacements.map((r) => r.original).sort(), ["GBfoods", "STAR"]);
});

Deno.test("generic variant fragments are not replaced on their own", () => {
  const { text } = applyDeterministicReplacement(
    "Il Made in Italy cresce. GBfoodsX non c'entra.",
    "STAR / GBfoods Italy LinkedIn",
    cfg,
  );
  // "Italy" alone is a stopword and "GBfoodsX" is a different word.
  assertEquals(text, "Il Made in Italy cresce. GBfoodsX non c'entra.");
});

Deno.test("a source that is a public body under any variant is fully preserved", () => {
  const { text, replacements, generalizedSourceName } = applyDeterministicReplacement(
    "Si riunisce oggi al MASAF la cabina di regia.",
    "MASAF LinkedIn",
    cfg,
  );
  assertEquals(text, "Si riunisce oggi al MASAF la cabina di regia.");
  assertEquals(replacements, []);
  assertEquals(generalizedSourceName, "MASAF LinkedIn");
});

Deno.test("keep_public_bodies=false replaces the ministry like any source", () => {
  const { text } = applyDeterministicReplacement(
    "Si riunisce oggi al MASAF la cabina di regia.",
    "MASAF LinkedIn",
    { ...cfg, keepPublicBodies: false },
  );
  assertEquals(text, "Si riunisce oggi al a food-sector organization la cabina di regia.");
});

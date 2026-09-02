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
  isNotOrganizationName,
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

// genericEntity is the operator's configured replacement wording (0019); the
// CUES preset value is used here so the existing expectations still read as the
// behaviour a food-sector deployment sees.
const cfg = {
  anonymizeCompanies: true,
  keepPublicBodies: true,
  companyAliases: {},
  genericEntity: "a food-sector organization",
};

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

// --- hashtags -----------------------------------------------------------
// The 2026-08-31 run leaked four company names, every one of them inside a
// hashtag: #FratelliBrancaDistillerie, #MuseoBranca, #GBfoodsItaly. A tag
// concatenates its words, so the word-boundary lookarounds used for prose can
// never fire inside one, and stage 2 does not return hashtags as entities.

Deno.test("a company name concatenated inside a hashtag is removed", () => {
  const { text } = applyDeterministicReplacement(
    "In bocca al lupo! #FratelliBrancaDistillerie #MuseoBranca #CompanyVisit",
    "Fratelli Branca Distillerie LinkedIn",
    cfg,
  );
  assertEquals(text.trim(), "In bocca al lupo! #CompanyVisit");
});

Deno.test("a single distinctive word of the name is matched inside a tag only", () => {
  // "#FernetBranca" goes; the same word loose in prose is left to stage 2,
  // because "Branca" is not a body-text variant and never should be.
  const { text } = applyDeterministicReplacement(
    "Un brindisi. #FernetBranca",
    "Fratelli Branca Distillerie LinkedIn",
    cfg,
  );
  assertEquals(text.trim(), "Un brindisi.");
});

Deno.test("a bare-name tag is removed, not rewritten into a broken tag", () => {
  // Running the variant loop first turned "#STAR" into
  // "#a food-sector organization" — a tag that still marks the spot.
  const { text } = applyDeterministicReplacement(
    "Novita. #STAR #Saikebon",
    "STAR / GBfoods Italy LinkedIn",
    cfg,
  );
  assertEquals(text.trim(), "Novita. #Saikebon");
});

Deno.test("sector and public-body acronyms in hashtags are preserved", () => {
  // The whole point of deriving acronyms from the SOURCE NAME only: #DOP and
  // #IGP are the subject matter, and #MASAF is a preserved public body.
  const { text } = applyDeterministicReplacement(
    "Vinitaly. #vinitaly26 #DOP #IGP #MASAF #sistemaagricoltura",
    "MASAF LinkedIn",
    cfg,
  );
  assertEquals(text.trim(), "Vinitaly. #vinitaly26 #DOP #IGP #MASAF #sistemaagricoltura");
});

Deno.test("an alias key removes a product-brand tag the source name cannot imply", () => {
  const { text } = applyDeterministicReplacement(
    "Un brindisi. #Carpano #Torino",
    "Fratelli Branca Distillerie LinkedIn",
    { ...cfg, companyAliases: { Carpano: "a food-sector organization" } },
  );
  assertEquals(text.trim(), "Un brindisi. #Torino");
});

Deno.test("the source-name acronym is a variant, junk initials are not", () => {
  assertEquals(sourceNameVariants("Fratelli Branca Distillerie LinkedIn"), [
    "Fratelli Branca Distillerie LinkedIn",
    "Fratelli Branca Distillerie",
    "FBD",
  ]);
});

// --- aliases as the lever for names the source label cannot imply ---------
// Product brands ("Carpano", "Fernet-Branca") appear in prose but are derivable
// from nothing: stage 1 only knows the source label, and stage 2 is told to skip
// "the source's own name". Both leaked on 2026-08-31 for exactly that reason.

const G = "a food-sector organization";
const brandCfg = {
  ...cfg,
  companyAliases: { Branca: G, Carpano: G, "Fernet-Branca": G },
};

Deno.test("an alias name is replaced in body text, not only in hashtags", () => {
  const { text } = applyDeterministicReplacement(
    "il ruolo di Carpano nel raccontarne le origini.",
    "Fratelli Branca Distillerie LinkedIn",
    brandCfg,
  );
  assertEquals(text, `il ruolo di ${G} nel raccontarne le origini.`);
});

Deno.test("longer alias names win over shorter ones they contain", () => {
  // "Branca" matching inside "Fernet-Branca" left "Fernet-a food-sector
  // organization" — a hyphen is not a letter, so the word boundaries allow it.
  const { text } = applyDeterministicReplacement(
    "Project Work dedicati a Fernet-Branca.",
    "Fratelli Branca Distillerie LinkedIn",
    brandCfg,
  );
  assertEquals(text, `Project Work dedicati a ${G}.`);
});

Deno.test("an alias applies inside a preserved public body's own post", () => {
  // The source being a ministry protects the MINISTRY's name, not a private
  // brand it happens to mention.
  const { text } = applyDeterministicReplacement(
    "Al MASAF si e parlato di Carpano.",
    "MASAF LinkedIn",
    brandCfg,
  );
  assertEquals(text, `Al MASAF si e parlato di ${G}.`);
});

Deno.test("an alias never overrides the public-body preservation list", () => {
  const { text } = applyDeterministicReplacement(
    "Il parere EFSA e arrivato.",
    "Fratelli Branca Distillerie LinkedIn",
    { ...cfg, companyAliases: { EFSA: G } },
  );
  assertEquals(text, "Il parere EFSA e arrivato.");
});

// --- public bodies, matched by containment ------------------------------
// isPublicBody compared for equality, so the extractor's real output never
// matched: it returns names as they appear in the text. The 2026-09-01 audit
// found ten institutions anonymised despite keep_public_bodies — AGEA under two
// spellings, a four-agency funding notice, Anci, the port authority, the
// agriculture committee, Copernicus.

Deno.test("a list entry inside a longer official name still preserves it", () => {
  assertEquals(isPublicBody("AGEA - Agenzia per le Erogazioni in Agricoltura"), true);
  assertEquals(isPublicBody("AGEA (Agecontrol)"), true);
  assertEquals(isPublicBody("Bando MASAF INAIL ISMEA CREA"), true);
  assertEquals(isPublicBody("Commissione Agricoltura"), true);
  assertEquals(isPublicBody("Capitanerie di Porto"), true);
  assertEquals(isPublicBody("Anci"), true);
});

Deno.test("the ambiguous acronyms match case-sensitively so common words do not fire", () => {
  // "WHO" and "UN" are on the list. A case-blind word match would preserve any
  // company whose name contains English "who" or Italian "un".
  assertEquals(isPublicBody("WHO"), true);
  assertEquals(isPublicBody("The Farmers Who Care"), false);
  assertEquals(isPublicBody("UN"), true);
  assertEquals(isPublicBody("Un Poco Distillerie"), false);
});

Deno.test("every other entry matches whatever casing the post used", () => {
  // The regression that broke this fix the first time: making ALL acronyms
  // case-sensitive stopped "Ismea" matching the list entry "ISMEA", which is
  // exactly the spelling the extractor returns.
  assertEquals(isPublicBody("Ismea"), true);
  assertEquals(isPublicBody("Agea"), true);
  assertEquals(isPublicBody("european commission"), true);
  assertEquals(isPublicBody("Camera dei Deputati"), true);
});

Deno.test("an ordinary company is still not a public body", () => {
  assertEquals(isPublicBody("Barilla"), false);
  assertEquals(isPublicBody("Citrus L'Orto Italiano"), false);
  assertEquals(isPublicBody("Eataly Lingotto"), false);
});

// --- entity shapes that are never an organisation -----------------------
// The audit found the extractor returning an amount of money and a lowercase
// category phrase; both were rewritten into "another food-sector
// organization", which changes what the post says rather than protecting
// anyone. Neither is a judgement call, so neither is left to the prompt.

Deno.test("an amount is not an organisation name", () => {
  assertEquals(isNotOrganizationName("6,2 milioni di euro"), true);
  assertEquals(isNotOrganizationName("300000-400000 euro"), true);
  assertEquals(isNotOrganizationName("2026"), true);
});

Deno.test("a name that merely contains digits is still a name", () => {
  assertEquals(isNotOrganizationName("Industry 4.0"), false);
  assertEquals(isNotOrganizationName("Gruppo 24 Ore"), false);
});

Deno.test("a lowercase multi-word phrase is a description, not a name", () => {
  assertEquals(isNotOrganizationName("associazioni di categoria"), true);
  assertEquals(isNotOrganizationName("trade associations"), true);
});

Deno.test("a single lowercase word is left to the prompt", () => {
  // Some brands really are written that way, and refusing here would leak one.
  assertEquals(isNotOrganizationName("adidas"), false);
  assertEquals(isNotOrganizationName("illycaffe"), false);
});

Deno.test("ordinary company names pass the shape guard", () => {
  assertEquals(isNotOrganizationName("Fratelli Branca Distillerie"), false);
  assertEquals(isNotOrganizationName("Carpano"), false);
  assertEquals(isNotOrganizationName(""), true);
});

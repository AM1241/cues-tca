/**
 * Deterministic anonymisation — ported close to verbatim from legacy
 * `anonymization_service.py` (see docs/legacy-system.md §3). Regex-based, no
 * LLM. Builds a replacement map from the post's own source name (and any
 * configured alias for it), preserves a hardcoded list of public bodies, and
 * always buckets percentages and large numbers into ranges (there is no
 * configurations column gating this — legacy called it optional, but nothing
 * here makes it conditional, so it always runs as part of the deterministic
 * pass).
 *
 * This pass alone reproduces the legacy behaviour, including its known gap:
 * a company named in body text but not matching the source is not caught
 * here. Closing that gap is entity.ts's job (the new LLM pass); this file's
 * findings and entity.ts's findings are merged into one replacements array
 * by the worker before the text is rewritten.
 */

// Public bodies are never anonymised regardless of anonymize_companies —
// mirrors the legacy hardcoded preservation list. The Italian institutions
// were added after the first widened run (2026-07-24): the extractor returned
// them as entities and, absent from this list, they were replaced — MASAF
// inconsistently so, because the model sometimes judged it to be the source.
const PUBLIC_BODIES = [
  "European Commission",
  "European Union",
  "EU",
  "EFSA",
  "FAO",
  "WHO",
  "OECD",
  "United Nations",
  "UN",
  "UNESCO",
  "MASAF",
  "ISMEA",
  "CREA",
  "INAIL",
  "AGEA",
  "Agenzia ICE",
  "Camera dei Deputati",
  "Senato della Repubblica",
  // Added after the 2026-09-01 over-replacement audit: both were returned by
  // the extractor and anonymised despite keep_public_bodies.
  "ANCI",
  "Copernicus",
];

/**
 * The only entries whose casing must match exactly. Their lowercase form is an
 * ordinary word — Italian "un" and "crea", English "who" — so a case-blind word
 * match would preserve any company whose name happens to contain one.
 * Everything else is matched case-insensitively, because the extractor returns
 * an institution in whatever casing the post used: "Ismea", "Agea", "Masaf".
 */
const CASE_SENSITIVE_BODIES = new Set(["EU", "UN", "WHO", "CREA"]);

export interface Replacement {
  original: string;
  replacement: string;
  source: "source_name" | "company_alias" | "entity_extraction";
}

export interface DeterministicConfig {
  anonymizeCompanies: boolean;
  keepPublicBodies: boolean;
  companyAliases: Record<string, string>;
  /**
   * What a company name is replaced with. Sector-specific, so it comes from
   * configurations.domain_generic_entity rather than being hardcoded here —
   * a food-sector string was one of the four things that made this tool
   * silently food-only. See 0019_editorial_domain.sql.
   */
  genericEntity: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Markers that identify a public institution by wording rather than by exact
 * name. The corpus is largely Italian-language, so the exact-match list above
 * (English/EU bodies only) never fired on things like "Carabinieri per la
 * Tutela Agroalimentare" or "AUSL" — the first real run replaced both with
 * "another food-sector organization".
 *
 * These patterns deliberately match unambiguous state-institution wording
 * only. Erring towards preserving is the safe direction: leaving a public body
 * named is what keep_public_bodies asks for, whereas failing to anonymise a
 * private company would be an actual leak.
 */
const PUBLIC_BODY_PATTERNS: RegExp[] = [
  /\bcarabinier/i,
  /\bguardia di finanza\b/i,
  /\bpolizia\b/i,
  /\bprefettura\b/i,
  /\bprocura\b/i,
  /\bminister/i,
  /\bministry\b/i,
  /\bausl\b/i,
  /\bas[lp]\b/i,
  /\bicqrf\b/i,
  /\bispettorato\b/i,
  /\bagenzia delle dogane\b/i,
  /\bregione\b/i,
  /\bcomune di\b/i,
  /\bprovincia di\b/i,
  /\bcapitaneri/i,
  /\bcommissione agricoltura\b/i,
  /\bcabina di regia\b/i,
  /\bcommissione europea\b/i,
  /\bunione europea\b/i,
  /\beuropean commission\b/i,
  /\bparlamento europeo\b/i,
];

/**
 * Is this name a public institution the pipeline must preserve?
 *
 * The list is matched by WHOLE-WORD CONTAINMENT, not equality. Equality was the
 * bug: "AGEA" is on the list, but the model returns the entity as it appears in
 * the text — "AGEA - Agenzia per le Erogazioni in Agricoltura", "AGEA
 * (Agecontrol)", "Bando MASAF INAIL ISMEA CREA" — none of which equals any list
 * entry, so all of them were anonymised despite keep_public_bodies. The
 * 2026-09-01 audit found ten such institutions replaced.
 *
 * Matching is case-insensitive except for the few entries listed in
 * CASE_SENSITIVE_BODIES, whose lowercase form is an ordinary word.
 */
export function isPublicBody(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "") return false;

  for (const body of PUBLIC_BODIES) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(body)}(?![\\p{L}\\p{N}])`,
      CASE_SENSITIVE_BODIES.has(body) ? "u" : "iu",
    );
    if (re.test(trimmed)) return true;
  }
  return PUBLIC_BODY_PATTERNS.some((re) => re.test(name));
}

/**
 * Does this extractor output have the SHAPE of an organisation name at all?
 *
 * The same audit found the model returning things that are not entities of any
 * kind and were rewritten into "another food-sector organization": the amount
 * "6,2 milioni di euro", the phrase "associazioni di categoria". Replacing
 * those protects nobody — it corrupts the fact. entity.ts's prompt now forbids
 * them, but a prompt is guidance, not an enforcement point, so the two cases
 * that can be judged from the string alone are refused here as well.
 *
 * Deliberately narrow. Anything only a gazetteer could settle — a country, a
 * person, a trade fair — is left to the prompt, because guessing wrong in THIS
 * direction leaks a real company name.
 */
export function isNotOrganizationName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed === "") return true;

  // A quantity, a date, a sum of money. Organisation names that carry digits
  // ("Industry 4.0", "Gruppo 24 Ore") also carry a capital; amounts do not.
  if (/[0-9]/.test(trimmed) && !/\p{Lu}/u.test(trimmed)) return true;

  // A lowercase multi-word phrase is a description, not a name. Single
  // lowercase words are left alone: some brands really are written that way.
  const words = trimmed.split(/\s+/u).filter((w) => /\p{L}/u.test(w));
  if (words.length > 1 && trimmed === trimmed.toLowerCase()) return true;

  return false;
}

// Variant fragments that are too generic to replace on their own — the
// country or platform half of a label like "GBfoods Italy LinkedIn".
const SOURCE_VARIANT_STOPWORDS = new Set([
  "linkedin",
  "italy",
  "italia",
  "food",
  "foods",
  "group",
  "gruppo",
]);

/**
 * Name forms under which a source may appear in body text. Source labels are
 * catalogue names ("STAR / GBfoods Italy LinkedIn") that never occur verbatim
 * in a post — the text says "GBfoods". Stage 2's prompt tells the model the
 * source has already been handled and must not be reported again, so any form
 * missed here survives BOTH stages: the first widened run (2026-07-24) leaked
 * "GBfoods" exactly this way.
 */
export function sourceNameVariants(sourceName: string): string[] {
  const variants = new Set<string>([sourceName.trim()]);
  const base = sourceName.replace(/\s+linkedin\s*$/i, "").trim();
  if (base) variants.add(base);
  for (const part of base.split("/")) {
    const p = part.trim();
    if (!p) continue;
    variants.add(p);
    const noCountry = p.replace(/\s+(italy|italia)\s*$/i, "").trim();
    if (noCountry) variants.add(noCountry);
  }
  // Initials of the multi-word forms: "Fratelli Branca Distillerie" -> "FBD".
  // Only acronyms DERIVED FROM THE SOURCE NAME are added — never acronyms in
  // general. The corpus is full of sector acronyms (#DOP, #IGP, #PNRR, #SRF01)
  // and public-body ones (#MASAF) that identify the subject rather than the
  // company; removing those would gut exactly the content this pipeline exists
  // to write about.
  //
  // Kept separate from the name-derived variants so the >= 4 length guard below
  // — which stops short fragments of a name matching common words — can stay as
  // it is, while a three-letter acronym still gets through.
  // Only from a clean multi-word name: a form still carrying "/" or the
  // "LinkedIn" suffix yields initials nobody writes ("STAR / GBfoods Italy
  // LinkedIn" -> "SGIL"), and a short nonsense string is exactly what would
  // false-match inside an unrelated hashtag.
  const acronyms = new Set<string>();
  for (const v of variants) {
    if (v.includes("/") || /\blinkedin\b/i.test(v)) continue;
    const words = v.split(/\s+/).filter((w) => /^\p{L}/u.test(w));
    if (words.length < 2) continue;
    const acronym = words.map((w) => w[0]).join("").toUpperCase();
    if (acronym.length >= 3) acronyms.add(acronym);
  }

  const named = [...variants].filter((v) => v.length >= 4);
  return [...named, ...acronyms]
    .filter((v) => !SOURCE_VARIANT_STOPWORDS.has(v.toLowerCase()))
    .sort((a, b) => b.length - a.length);
}

/**
 * Company names hidden inside hashtags.
 *
 * A hashtag concatenates its words, so the word-boundary lookarounds used for
 * body text can never fire inside one: in "#FratelliBrancaDistillerie" the
 * variant "Branca" has letters on both sides, and the spaced full name does not
 * appear at all. All four leaks in the 2026-08-31 run were exactly this —
 * #FratelliBrancaDistillerie, #MuseoBranca, #GBfoodsItaly — and stage 2 does not
 * cover them either, since the model does not return hashtags as entities.
 *
 * The whole tag is dropped rather than rewritten: "#a food-sector organization"
 * is not a hashtag, and a tag naming the company has no place in anonymised
 * text. Comparison ignores case and the spaces the concatenation removed.
 */
export function stripIdentifyingHashtags(
  text: string,
  variants: string[],
): { text: string; removed: string[] } {
  // Inside a hashtag, single distinctive words of the name are also matched —
  // "#MuseoBranca" and "#FernetBranca" name the company as surely as the full
  // label does, and the variant list never contains bare "Branca" because the
  // name is only ever split on "/", not into words.
  //
  // These words are deliberately NOT added to the body-text variants: "Fratelli"
  // or "Distillerie" loose in Italian prose would over-replace, whereas a
  // hashtag is a closed context where the word can only be naming the company.
  const words = variants
    .flatMap((v) => v.split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w.length >= 4 && !SOURCE_VARIANT_STOPWORDS.has(w.toLowerCase()));

  const needles = [...variants, ...words]
    .map((v) => v.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase())
    .filter((v) => v.length >= 3);
  if (needles.length === 0) return { text, removed: [] };

  const removed: string[] = [];
  const out = text.replace(/#[\p{L}\p{N}_]+/gu, (tag) => {
    const flat = tag.slice(1).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    if (!needles.some((n) => flat.includes(n))) return tag;
    removed.push(tag);
    return "";
  });

  // Collapse the run of spaces a removed tag leaves behind, without touching
  // line structure — hashtag blocks are usually their own trailing lines.
  return { text: out.replace(/[^\S\r\n]{2,}/g, " "), removed };
}

/**
 * Deterministic pass over one post's text. Replaces every variant of the
 * source's own name (and any configured alias target found in the text) with
 * a generic phrase, unless the source itself is a preserved public body under
 * any of its variants ("MASAF LinkedIn" is the ministry, not a company).
 */
export function applyDeterministicReplacement(
  text: string,
  sourceName: string,
  config: DeterministicConfig,
): { text: string; replacements: Replacement[]; generalizedSourceName: string } {
  const replacements: Replacement[] = [];
  let result = text;

  const variants = sourceNameVariants(sourceName);
  const preserveSource = config.keepPublicBodies && variants.some(isPublicBody);
  const generic = config.genericEntity;

  // A name is replaced by a regex with Unicode lookarounds rather than \b: the
  // corpus is Italian and \b misfires next to accented letters.
  const replaceName = (name: string, to: string, kind: Replacement["source"]) => {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`,
      "gu",
    );
    if (!re.test(result)) return;
    re.lastIndex = 0;
    result = result.replace(re, to);
    replacements.push({ original: name, replacement: to, source: kind });
  };

  if (config.anonymizeCompanies) {
    const alias = config.companyAliases[sourceName];
    const target = alias ?? generic;

    // Hashtags FIRST. Running after the name loops leaves "#STAR" rewritten as
    // "#a food-sector organization" — a broken tag that still marks the spot.
    const needles = [...Object.keys(config.companyAliases)];
    if (!preserveSource) needles.push(...variants);
    const stripped = stripIdentifyingHashtags(result, needles);
    result = stripped.text;
    for (const tag of stripped.removed) {
      replacements.push({ original: tag, replacement: "", source: "source_name" });
    }

    // Operator-configured names, applied whatever the source is: a private
    // brand named inside a MINISTRY's post still has to go. These are the only
    // lever for names the source label cannot imply — product brands like
    // "Carpano" or "Fernet-Branca", which stage 1 cannot derive and stage 2 is
    // told to skip as "the source's own name". That gap is what leaked them.
    // Longest first, as the variant list already is: "Branca" would otherwise
    // match inside "Fernet-Branca" (a hyphen is not a letter, so the word
    // boundaries allow it) and leave "Fernet-a food-sector organization".
    const aliasEntries = Object.entries(config.companyAliases)
      .sort(([a], [b]) => b.length - a.length);
    for (const [name, to] of aliasEntries) {
      if (name === sourceName) continue; // its own label is a variant already
      if (config.keepPublicBodies && isPublicBody(name)) continue;
      replaceName(name, to, "company_alias");
    }

    // The source's own name, unless the source IS a preserved public body.
    if (!preserveSource) {
      for (const variant of variants) {
        replaceName(variant, target, alias ? "company_alias" : "source_name");
      }
    }
  }

  result = bucketPercentages(bucketLargeNumbers(result));

  const generalizedSourceName = preserveSource ? sourceName : (config.companyAliases[sourceName] ?? generic);

  return { text: result, replacements, generalizedSourceName };
}

/**
 * Bucket a percentage into a coarse range, e.g. "37%" -> "30-40%".
 *
 * The decimal separator may be "." or "," — the corpus is Italian, and a
 * "\.\d+"-only pattern matched the fractional digit on its own: "+25,7%"
 * became "+25,0-10%". The lookbehind stops a match starting mid-number.
 */
export function bucketPercentages(text: string): string {
  return text.replace(/(?<![\d.,])(\d{1,3})(?:[.,]\d+)?%/g, (_match, whole: string) => {
    const n = Number(whole);
    if (!Number.isFinite(n) || n < 0 || n > 100) return _match;
    const lower = Math.floor(n / 10) * 10;
    const upper = lower + 10;
    return `${lower}-${upper}%`;
  });
}

/** A four-digit year, not a quantity to be generalised. */
function isYear(n: number, digits: number): boolean {
  return digits === 4 && n >= 1900 && n <= 2099;
}

/**
 * Bucket large plain numbers (>= 1000) into an order-of-magnitude range.
 *
 * Years are exempt: the first real run turned "tra il 2021 e il 2025" into
 * "tra il 2000-3000 e il 2000-3000", which destroys the meaning of any post
 * that cites a period, a regulation year or a plan.
 */
export function bucketLargeNumbers(text: string): string {
  return text.replace(/\b(\d{4,})\b/g, (match) => {
    const n = Number(match);
    if (!Number.isFinite(n)) return match;
    if (isYear(n, match.length)) return match;
    const magnitude = 10 ** Math.floor(Math.log10(n));
    const lower = Math.floor(n / magnitude) * magnitude;
    const upper = lower + magnitude;
    return `${lower}-${upper}`;
  });
}

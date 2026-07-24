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
// mirrors the legacy hardcoded preservation list.
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
];

export interface Replacement {
  original: string;
  replacement: string;
  source: "source_name" | "company_alias" | "entity_extraction";
}

export interface DeterministicConfig {
  anonymizeCompanies: boolean;
  keepPublicBodies: boolean;
  companyAliases: Record<string, string>;
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
  /\bcommissione europea\b/i,
  /\bunione europea\b/i,
  /\beuropean commission\b/i,
  /\bparlamento europeo\b/i,
];

export function isPublicBody(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (PUBLIC_BODIES.some((b) => b.toLowerCase() === lower)) return true;
  return PUBLIC_BODY_PATTERNS.some((re) => re.test(name));
}

/**
 * Deterministic pass over one post's text. Replaces the source's own name
 * (and any configured alias target found in the text) with a generic
 * phrase, unless the source itself is a preserved public body.
 */
export function applyDeterministicReplacement(
  text: string,
  sourceName: string,
  config: DeterministicConfig,
): { text: string; replacements: Replacement[]; generalizedSourceName: string } {
  const replacements: Replacement[] = [];
  let result = text;

  const preserveSource = config.keepPublicBodies && isPublicBody(sourceName);
  const generic = "a food-sector organization";

  if (config.anonymizeCompanies && !preserveSource) {
    const alias = config.companyAliases[sourceName];
    const target = alias ?? generic;

    if (result.includes(sourceName)) {
      const re = new RegExp(escapeRegExp(sourceName), "g");
      result = result.replace(re, target);
      replacements.push({
        original: sourceName,
        replacement: target,
        source: alias ? "company_alias" : "source_name",
      });
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

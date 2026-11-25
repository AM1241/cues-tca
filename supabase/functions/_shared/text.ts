/**
 * Text helpers for anything that ends up in a request body to OpenAI.
 *
 * JavaScript strings are UTF-16: an emoji such as 🌱 is two code units, a
 * "surrogate pair". `text.slice(0, n)` counts code units, so a cut that lands
 * between the two halves leaves a lone half behind. JSON.stringify writes that
 * half as an escape like "\ud83c", which is valid JSON syntax but not a valid
 * character, and OpenAI refuses the whole request with 400 "Invalid body:
 * failed to parse JSON value".
 *
 * Found on production on 2026-11-24: every "Create the carousel" of the 9–24
 * November grouping failed that way, because three of its posts had an emoji
 * exactly at the 500-character cut in generate/prompt.ts.
 */

/** Cuts text to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // first half of a pair: leave it out with its partner
  return text.slice(0, end);
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Replaces any lone surrogate with U+FFFD, so the text serialises to JSON every parser accepts. */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}

/**
 * JSON.stringify for request bodies: every string in the value is made
 * well-formed first. A last line of defence for text that arrives broken
 * from a source, whatever cut it.
 */
export function requestJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "string" ? wellFormed(v) : v));
}

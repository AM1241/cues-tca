/**
 * POST /functions/v1/discover-brands
 *
 *   { "source_id": "…", "sample_size": 1..40? }   // default 25
 *
 * Reads one source's own posts and proposes the names that identify its
 * company — product brands, historical names, subsidiaries, venues. The
 * anonymiser can only derive forms of a source's LABEL, and stage 2 is told to
 * skip "the source's own name", so these fall between the two stages: exactly
 * how "Carpano" and "Fernet-Branca" survived into anonymised text on
 * 2026-08-31. See 0020_brand_suggestions.sql.
 *
 * Everything returned is stored as a PROPOSAL. Nothing here changes
 * anonymisation until an editor calls accept_brand_suggestion. The reason is
 * asymmetric risk: a missed brand costs one more review round, whereas a
 * proposed CATEGORY ("vermouth") silently rewrites every mention of the product
 * as "a food-sector organization" and is not noticed until the copy is nonsense.
 *
 * Dual auth (internal secret OR an admin editor), like every other stage. Reads
 * RAW post text deliberately — seeing the names before anonymisation is the
 * entire point.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { RequestError } from "../_shared/errors.ts";
import { callOpenAi, OpenAiError, type CallOpenAiOptions } from "../_shared/openai.ts";
import { isPublicBody, sourceNameVariants } from "../anonymize-worker/deterministic.ts";
import {
  buildDiscoveryPrompt,
  buildDiscoverySchema,
  parseDiscoveryOutput,
  type DiscoveredName,
} from "./prompt.ts";
import {
  getConfig,
  getExistingSuggestions,
  getSource,
  getSourcePosts,
  insertSuggestions,
} from "./data.ts";

const DEFAULT_SAMPLE_SIZE = 25;
const MAX_SAMPLE_SIZE = 40;

/** Model for the discovery call. Cheap: one call per source, once. */
const MODEL = "gpt-5.4-nano";

export interface DiscoverBrandsDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  callOpenAiImpl?: typeof callOpenAi;
}

function parseSampleSize(body: Record<string, unknown>): number {
  const raw = body.sample_size;
  if (raw === undefined || raw === null) return DEFAULT_SAMPLE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_SAMPLE_SIZE) {
    throw new RequestError(400, `sample_size must be an integer between 1 and ${MAX_SAMPLE_SIZE}.`);
  }
  return n;
}

/**
 * Names the operator must never be asked about.
 *
 * Public bodies are the important one: the pipeline deliberately preserves
 * ministries and agencies, so proposing one is offering to break that on
 * purpose. The rest are noise filters — a name already known, or already
 * decided for this source.
 */
export function filterProposals(
  proposed: DiscoveredName[],
  opts: { sourceLabel: string; knownAliases: string[]; alreadySuggested: string[] },
): { kept: DiscoveredName[]; skipped: { name: string; reason: string }[] } {
  const lower = (s: string) => s.trim().toLowerCase();
  const known = new Set(opts.knownAliases.map(lower));
  const seen = new Set(opts.alreadySuggested.map(lower));
  // Every form the anonymiser already derives from the label, not just the label
  // verbatim — the first live run proposed "Fratelli Branca Distillerie", which
  // stage 1 has always handled. Harmless to accept, but it is noise in a list
  // the operator has to read carefully.
  const ownNames = new Set(sourceNameVariants(opts.sourceLabel).map(lower));
  ownNames.add(lower(opts.sourceLabel));

  const kept: DiscoveredName[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const inThisBatch = new Set<string>();

  for (const p of proposed) {
    const key = lower(p.name);
    if (!key) continue;
    if (inThisBatch.has(key)) continue;
    if (ownNames.has(key)) { skipped.push({ name: p.name, reason: "source_label" }); continue; }
    if (known.has(key)) { skipped.push({ name: p.name, reason: "already_alias" }); continue; }
    if (seen.has(key)) { skipped.push({ name: p.name, reason: "already_suggested" }); continue; }
    if (isPublicBody(p.name)) { skipped.push({ name: p.name, reason: "public_body" }); continue; }
    inThisBatch.add(key);
    kept.push(p);
  }
  return { kept, skipped };
}

export async function handleDiscoverBrands(
  req: Request,
  deps: DiscoverBrandsDeps = {},
): Promise<Response> {
  const origin = req.headers.get("Origin");

  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405, origin);
  }

  try {
    let body: unknown = {};
    const rawBody = await req.text();
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new RequestError(400, "Body is not valid JSON.");
      }
    }

    await authenticate(req, body as Record<string, unknown>);

    const b = body as Record<string, unknown>;
    const sourceId = typeof b.source_id === "string" ? b.source_id.trim() : "";
    if (!sourceId) throw new RequestError(400, "source_id is required.");
    const sampleSize = parseSampleSize(b);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");

    const db = deps.db ?? serviceClient();

    const source = await getSource(db, sourceId);
    if (!source) throw new RequestError(404, "Source not found.");

    const posts = await getSourcePosts(db, sourceId, sampleSize);
    if (posts.length === 0) {
      // Nothing collected yet is an honest empty result, not a failure.
      return jsonResponse(
        { ok: true, source: source.name, totals: { read: 0, proposed: 0, stored: 0 }, suggestions: [] },
        200,
        origin,
      );
    }

    const config = await getConfig(db);
    const domain = config.editorial_domain?.trim() || "its editorial domain";
    const knownAliases = Object.keys(config.company_aliases ?? {});
    const alreadySuggested = await getExistingSuggestions(db, sourceId);

    const call = deps.callOpenAiImpl ?? callOpenAi;
    let result;
    try {
      result = await call({
        apiKey,
        model: MODEL,
        input: buildDiscoveryPrompt(source.name, domain, posts, [...knownAliases, ...alreadySuggested]),
        jsonSchema: buildDiscoverySchema(),
        fetchImpl: deps.fetchImpl,
      } satisfies CallOpenAiOptions);
    } catch (e) {
      // Discovery is advisory: a provider failure means the operator tries
      // again, so it is surfaced plainly rather than dead-lettered anywhere.
      const oe = e instanceof OpenAiError ? e : null;
      throw new RequestError(502, `Discovery call failed: ${oe?.failureType ?? (e as Error).message}`);
    }

    const proposed = parseDiscoveryOutput(result.parsed);
    const { kept, skipped } = filterProposals(proposed, {
      sourceLabel: source.name,
      knownAliases,
      alreadySuggested,
    });
    const stored = await insertSuggestions(db, sourceId, kept);

    return jsonResponse(
      {
        ok: true,
        source: source.name,
        totals: {
          read: posts.length,
          proposed: proposed.length,
          stored: stored.length,
          skipped: skipped.length,
        },
        suggestions: stored,
        skipped,
      },
      200,
      origin,
    );
  } catch (e) {
    if (e instanceof RequestError) {
      return jsonResponse({ ok: false, error: e.message }, e.status, origin);
    }
    console.error("discover-brands failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleDiscoverBrands(req));
}

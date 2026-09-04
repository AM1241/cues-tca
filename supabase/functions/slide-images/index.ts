/**
 * POST /functions/v1/slide-images
 *
 *   { "position": 3, "heading": "…", "body": "…", "quality": "medium"? }
 *
 * Generates ONE background image for ONE carousel slide and returns it as
 * base64. The slide's own words are never sent to be drawn — see prompt.ts for
 * why, and frontend/src/lib/slides.ts for what draws them instead.
 *
 * WHY ONE SLIDE PER REQUEST, NOT A WHOLE CAROUSEL
 * Image generation takes tens of seconds. A publication can carry up to ten
 * slides, so a batch endpoint would sit well past any sensible Edge Function
 * timeout and lose every image in the batch when it tripped. One per request
 * means the client shows real progress, a single failure costs one image rather
 * than ten, and a retry re-spends the price of one.
 *
 * WHY NOTHING IS STORED
 * The image comes back to the browser, which composites the text over it and
 * downloads the finished PNG. Persisting it would mean a Storage bucket, a
 * policy, signed URLs and a cleanup job — the same trade lib/docx.ts rejected —
 * and the operator's own downloaded files are the artefact that matters. The
 * cost of that choice, stated plainly: regenerating a carousel's images is
 * billed again. It is a deliberate click, priced per slide, not something that
 * happens on its own.
 *
 * Admin-gated through the shared authenticate(), like every other stage that
 * spends provider quota.
 */
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { authenticate } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { RequestError } from "../_shared/errors.ts";
import { OpenAiError } from "../_shared/openai.ts";
import {
  callOpenAiImage,
  type CallOpenAiImageOptions,
  type ImageQuality,
} from "../_shared/openai_images.ts";
import {
  buildSlideImagePrompt,
  IMAGE_MODEL,
  IMAGE_PROMPT_VERSION,
  IMAGE_SIZE,
  type SlideForImage,
} from "./prompt.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.110.8";

export interface SlideImagesDeps {
  db?: SupabaseClient;
  fetchImpl?: typeof fetch;
  callOpenAiImageImpl?: typeof callOpenAiImage;
}

const QUALITIES: ImageQuality[] = ["low", "medium", "high"];

/**
 * Bounded because the string reaches a paid API: the heading and body are
 * truncated into the prompt anyway (prompt.ts), so anything longer is a caller
 * bug rather than a legitimate slide.
 */
const MAX_FIELD_CHARS = 2_000;

function requiredString(body: Record<string, unknown>, key: string): string {
  const raw = body[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new RequestError(400, `${key} is required and must be a non-empty string.`);
  }
  if (raw.length > MAX_FIELD_CHARS) {
    throw new RequestError(400, `${key} must be at most ${MAX_FIELD_CHARS} characters.`);
  }
  return raw;
}

export function parseSlideRequest(body: Record<string, unknown>): {
  slide: SlideForImage;
  quality: ImageQuality;
} {
  const position = Number(body.position);
  if (!Number.isInteger(position) || position < 1 || position > 20) {
    throw new RequestError(400, "position must be an integer between 1 and 20.");
  }

  const rawQuality = body.quality;
  if (rawQuality !== undefined && !QUALITIES.includes(rawQuality as ImageQuality)) {
    throw new RequestError(400, `quality must be one of ${QUALITIES.join(", ")}.`);
  }

  return {
    slide: {
      position,
      heading: requiredString(body, "heading"),
      // A closing slide can legitimately carry a very short body, but never an
      // empty one — the schema in generate/prompt.ts requires both.
      body: requiredString(body, "body"),
    },
    // Medium by default: the scrim darkens whatever comes back, so the extra
    // fidelity of 'high' is largely spent on detail the composite hides.
    quality: (rawQuality as ImageQuality) ?? "medium",
  };
}

export async function handleSlideImages(
  req: Request,
  deps: SlideImagesDeps = {},
): Promise<Response> {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const origin = req.headers.get("Origin");

  try {
    if (req.method !== "POST") throw new RequestError(405, "Use POST.");

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      throw new RequestError(400, "Body must be JSON.");
    }

    await authenticate(req, body);

    const { slide, quality } = parseSlideRequest(body);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new RequestError(500, "OPENAI_API_KEY is not configured.");

    // The domain comes from the configurations row, never from the request:
    // it is the same editorial scope every other stage reads, and letting a
    // caller pass it would let the picture drift from the copy's own subject.
    const db = deps.db ?? serviceClient();
    const { data: config, error: configErr } = await db
      .from("configurations")
      .select("editorial_domain")
      .eq("id", "default")
      .single();
    if (configErr) throw new RequestError(500, `configurations lookup failed: ${configErr.message}`);

    const prompt = buildSlideImagePrompt(slide, {
      domain: (config as { editorial_domain?: string })?.editorial_domain ?? undefined,
    });

    const call = deps.callOpenAiImageImpl ?? callOpenAiImage;
    let result;
    try {
      result = await call({
        apiKey,
        model: IMAGE_MODEL,
        prompt,
        size: IMAGE_SIZE,
        quality,
        outputFormat: "jpeg",
        fetchImpl: deps.fetchImpl,
      } satisfies CallOpenAiImageOptions);
    } catch (e) {
      const oe = e instanceof OpenAiError ? e : null;
      // Surfaced rather than dead-lettered: this is an interactive, operator-
      // initiated action with a person watching, and the slide it belongs to
      // is still on their screen to retry.
      throw new RequestError(
        oe?.failureType === "content_filter" ? 422 : 502,
        `Slide ${slide.position} image failed: ${oe?.message ?? (e as Error).message}`,
      );
    }

    return jsonResponse(
      {
        ok: true,
        position: slide.position,
        model: IMAGE_MODEL,
        prompt_version: IMAGE_PROMPT_VERSION,
        size: IMAGE_SIZE,
        quality,
        output_format: "jpeg",
        image_b64: result.b64,
        revised_prompt: result.revisedPrompt,
        provider_response: result.raw,
      },
      200,
      origin,
    );
  } catch (e) {
    if (e instanceof RequestError) {
      return jsonResponse({ ok: false, error: e.message }, e.status, origin);
    }
    console.error("slide-images failed:", e);
    return jsonResponse({ ok: false, error: "Internal error." }, 500, origin);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleSlideImages(req));
}

/**
 * OpenAI Images API client — POST /v1/images/generations.
 *
 * Separate from _shared/openai.ts on purpose: that module's own header commits
 * it to "Responses API, structured outputs only", and image generation is a
 * different endpoint with a different request and response shape. Sharing the
 * failure taxonomy (OpenAiError) rather than the transport keeps the two honest.
 *
 * Same house rules as the text client: no silent fallback, every distinguishable
 * failure surfaced as a typed error, and the raw response handed back so the
 * caller can store it verbatim.
 */
import { OpenAiError, type OpenAiFailureType } from "./openai.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1/images/generations";

/**
 * Image generation is slow — tens of seconds is normal, unlike the text calls
 * this project makes elsewhere. A 60s timeout copied from the text client would
 * turn ordinary latency into a failure.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";

export interface CallOpenAiImageOptions {
  apiKey: string;
  model: string;
  prompt: string;
  /** Must have both edges divisible by 16 (API rule), e.g. "1024x1024". */
  size: string;
  quality?: ImageQuality;
  outputFormat?: ImageOutputFormat;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface OpenAiImageResult {
  /** Base64 image bytes, in `outputFormat`. */
  b64: string;
  /**
   * The model's own rewrite of the prompt, when it returns one. Worth keeping:
   * it is the only record of what was actually drawn when the result surprises
   * someone later.
   */
  revisedPrompt: string | null;
  /** Stored verbatim by the caller, minus the image bytes — see stripImageBytes. */
  raw: unknown;
}

function retryAfterFromHeaders(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function failureTypeForStatus(status: number): OpenAiFailureType {
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  return "client_error";
}

/**
 * The base64 image is megabytes and must never reach a log line or a jsonb
 * column — it would bloat every row that records a call and make the audit
 * trail unreadable. Everything else in the response is small and worth keeping.
 */
export function stripImageBytes(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const body = raw as Record<string, unknown>;
  const data = Array.isArray(body.data) ? body.data : null;
  if (!data) return body;
  return {
    ...body,
    data: data.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const { b64_json, ...rest } = entry as Record<string, unknown>;
      return { ...rest, b64_json_bytes: typeof b64_json === "string" ? b64_json.length : 0 };
    }),
  };
}

export async function callOpenAiImage(opts: CallOpenAiImageOptions): Promise<OpenAiImageResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await doFetch(opts.baseUrl ?? DEFAULT_BASE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        prompt: opts.prompt,
        size: opts.size,
        quality: opts.quality ?? "medium",
        n: 1,
        output_format: opts.outputFormat ?? "jpeg",
        // The slide compositor draws over the whole square, so a transparent
        // background would only produce a hole for the page colour to show
        // through — never what is wanted here.
        background: "opaque",
      }),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = (e as Error)?.name === "AbortError";
    throw new OpenAiError(
      aborted ? "timeout" : "network",
      aborted ? "Image request timed out." : `Image request failed: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = "";
    let body: unknown = null;
    try {
      body = await res.json();
      detail = (body as { error?: { message?: string } })?.error?.message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    // A refusal arrives as a 400 naming the moderation system rather than as a
    // distinct status, so it is classified here instead of being reported as a
    // generic bad request the operator would try to "fix" by editing the slide.
    const moderated = /safety|moderation|content[_ ]policy|rejected/i.test(detail);
    throw new OpenAiError(
      moderated ? "content_filter" : failureTypeForStatus(res.status),
      `Image generation failed (${res.status}): ${detail || res.statusText}`,
      res.status,
      retryAfterFromHeaders(res),
      body,
    );
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new OpenAiError("invalid_json", `Image response was not JSON: ${(e as Error).message}`);
  }

  const entry = (raw as { data?: unknown[] })?.data?.[0] as
    | { b64_json?: unknown; revised_prompt?: unknown }
    | undefined;

  if (!entry || typeof entry.b64_json !== "string" || entry.b64_json.length === 0) {
    throw new OpenAiError(
      "empty_output",
      "Image response carried no b64_json image data.",
      res.status,
      undefined,
      stripImageBytes(raw),
    );
  }

  return {
    b64: entry.b64_json,
    revisedPrompt: typeof entry.revised_prompt === "string" ? entry.revised_prompt : null,
    raw: stripImageBytes(raw),
  };
}

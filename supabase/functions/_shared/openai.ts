/**
 * OpenAI Responses API client, structured outputs only.
 *
 * `store:false` — nothing is retained on OpenAI's side; the append-only
 * `scoring_results.provider_response` column is our only record.
 *
 * There is no silent fallback here. Every failure mode the caller must
 * distinguish (refusal, incomplete, content filter, empty, 429, 5xx, timeout,
 * other 4xx) is surfaced as a typed `OpenAiError`, never swallowed into a
 * default score.
 */

export type OpenAiFailureType =
  | "refusal"
  | "incomplete"
  | "content_filter"
  | "empty_output"
  | "invalid_json"
  | "schema_mismatch"
  | "rate_limit"
  | "server_error"
  | "network"
  | "timeout"
  | "client_error";

export class OpenAiError extends Error {
  constructor(
    readonly failureType: OpenAiFailureType,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
    readonly rawResponse?: unknown,
  ) {
    super(message);
    this.name = "OpenAiError";
  }

  /** Only genuinely transient failures are worth a retry. */
  get retryable(): boolean {
    return this.failureType === "rate_limit" || this.failureType === "server_error" ||
      this.failureType === "network" || this.failureType === "timeout";
  }
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
}

export interface CallOpenAiOptions {
  apiKey: string;
  model: string;
  input: string;
  jsonSchema: JsonSchemaFormat;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface OpenAiCallResult {
  /** Parsed JSON object, already validated against the schema by the API. */
  parsed: Record<string, unknown>;
  /** The full response body, stored verbatim in provider_response. */
  raw: unknown;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1/responses";
const DEFAULT_TIMEOUT_MS = 60_000;

function retryAfterFromHeaders(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const n = Number(h);
  return Number.isFinite(n) ? n : undefined;
}

export async function callOpenAi(opts: CallOpenAiOptions): Promise<OpenAiCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.baseUrl ?? DEFAULT_BASE_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        input: opts.input,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: opts.jsonSchema.name,
            schema: opts.jsonSchema.schema,
            strict: true,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new OpenAiError("timeout", "OpenAI request timed out.");
    }
    throw new OpenAiError("network", `OpenAI request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 429) {
    throw new OpenAiError("rate_limit", "OpenAI rate limited the request.", 429, retryAfterFromHeaders(res));
  }
  if (res.status >= 500) {
    throw new OpenAiError("server_error", `OpenAI server error (${res.status}).`, res.status);
  }
  if (res.status >= 400) {
    const body = await res.text().catch(() => "");
    throw new OpenAiError("client_error", `OpenAI rejected the request (${res.status}): ${body.slice(0, 500)}`, res.status);
  }

  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    throw new OpenAiError("invalid_json", "OpenAI response body was not valid JSON.");
  }

  const status = body.status as string | undefined;
  if (status === "incomplete") {
    const reason = (body.incomplete_details as Record<string, unknown> | undefined)?.reason;
    throw new OpenAiError("incomplete", `OpenAI response incomplete (reason=${reason ?? "unknown"}).`, undefined, undefined, body);
  }

  const output = body.output as Array<Record<string, unknown>> | undefined;
  const message = output?.find((o) => o.type === "message");
  const content = (message?.content as Array<Record<string, unknown>> | undefined)?.[0];

  if (content?.type === "refusal") {
    throw new OpenAiError("refusal", `OpenAI refused: ${(content.refusal as string) ?? "no reason given"}`, undefined, undefined, body);
  }

  const text = content?.type === "output_text" ? (content.text as string) : undefined;
  if (!text) {
    throw new OpenAiError("empty_output", "OpenAI response had no output text.", undefined, undefined, body);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenAiError("invalid_json", "OpenAI output_text was not valid JSON.", undefined, undefined, body);
  }

  return { parsed, raw: body };
}

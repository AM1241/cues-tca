/**
 * OpenAI Embeddings API client. Separate from openai.ts's callOpenAi, which
 * is Responses-API/structured-output specific — embeddings use a distinct
 * endpoint and response shape.
 *
 * No silent fallback here either: any failure is a typed EmbeddingError, the
 * caller decides what to do (per-post exclusion, not a canned vector).
 */

export type EmbeddingFailureType =
  | "rate_limit"
  | "server_error"
  | "network"
  | "timeout"
  | "client_error"
  | "invalid_json"
  | "empty_output";

export class EmbeddingError extends Error {
  constructor(
    readonly failureType: EmbeddingFailureType,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export interface CallEmbeddingOptions {
  apiKey: string;
  model: string;
  input: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function callEmbedding(opts: CallEmbeddingOptions): Promise<number[]> {
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
      body: JSON.stringify({ model: opts.model, input: opts.input }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new EmbeddingError("timeout", "Embedding request timed out.");
    }
    throw new EmbeddingError("network", `Embedding request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 429) {
    throw new EmbeddingError("rate_limit", "OpenAI rate limited the embedding request.", 429);
  }
  if (res.status >= 500) {
    throw new EmbeddingError("server_error", `OpenAI server error (${res.status}).`, res.status);
  }
  if (res.status >= 400) {
    const body = await res.text().catch(() => "");
    throw new EmbeddingError("client_error", `OpenAI rejected the embedding request (${res.status}): ${body.slice(0, 500)}`, res.status);
  }

  let body: Record<string, unknown>;
  try {
    body = await res.json();
  } catch {
    throw new EmbeddingError("invalid_json", "OpenAI embedding response body was not valid JSON.");
  }

  const data = body.data as Array<{ embedding?: number[] }> | undefined;
  const embedding = data?.[0]?.embedding;
  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
    throw new EmbeddingError("empty_output", "OpenAI embedding response had no vector.");
  }

  return embedding;
}

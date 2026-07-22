/**
 * Fixture responses and a scripted fetch. Nothing in the test suite touches the
 * network: every provider interaction is served from here.
 */

export function post(id: string, text: string, publishedAt: string | number) {
  return {
    urn: `urn:li:activity:${id}`,
    text,
    url: `https://www.linkedin.com/posts/masaf_x-activity-${id}-aAaA`,
    postedAt: publishedAt,
    poster: { name: "MASAF" },
    num_likes: 12,
    num_comments: 3,
  };
}

/** Days ago, as an ISO string the parser accepts. */
export function daysAgo(n: number, from = new Date()): string {
  return new Date(from.getTime() - n * 86_400_000).toISOString();
}

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw a network-style error instead of responding. */
  throws?: "network" | "abort";
  /** Never settle, so the request timeout fires. */
  hang?: boolean;
}

export interface ScriptedFetch {
  fetchImpl: typeof fetch;
  /** Every URL requested, in order. Length == outbound HTTP attempts. */
  calls: string[];
}

/**
 * Serves `script` in order; the last entry repeats once exhausted.
 * `calls` is the ground truth for provider_requests assertions.
 */
export function scriptedFetch(script: ScriptedResponse[]): ScriptedFetch {
  const calls: string[] = [];
  let i = 0;

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const step = script[Math.min(i, script.length - 1)];
    i++;

    if (step.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The signal has been aborted", "AbortError"));
        });
      });
    }
    if (step.throws === "network") {
      return Promise.reject(new TypeError("connection refused"));
    }
    if (step.throws === "abort") {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }

    const status = step.status ?? 200;
    const body = step.body === undefined ? [] : step.body;
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...(step.headers ?? {}) },
      }),
    );
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** Backoff is real in production; tests must not actually wait for it. */
export const noSleep = (_ms: number) => Promise.resolve();

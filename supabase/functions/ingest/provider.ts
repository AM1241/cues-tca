/**
 * RapidAPI "Fresh LinkedIn Profile Data" client.
 *
 *   GET /get-company-posts?linkedin_url=<url>&start=<offset>
 *   headers: x-rapidapi-key, x-rapidapi-host
 *
 * `fetch` is injected so every test in this repo runs against fixtures. Nothing
 * here should ever reach the network during a test run.
 */
import { ProviderError } from "../_shared/errors.ts";
import { isWithinLookback, normalizePage } from "./normalize.ts";
import type { NormalizedPost } from "./types.ts";

export const DEFAULT_HOST = "fresh-linkedin-profile-data.p.rapidapi.com";
export const COMPANY_POSTS_PATH = "/get-company-posts";

/** Hard ceiling per source. A misconfigured lookback must not drain quota. */
export const MAX_PAGES = 5;
export const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

export type FetchLike = typeof fetch;

export interface ProviderOptions {
  apiKey: string;
  host?: string;
  fetchImpl?: FetchLike;
  /** Injected for deterministic tests; real runs use the default. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface PageResult {
  posts: NormalizedPost[];
  skippedNoId: number;
  skippedMalformed: number;
  rawCount: number;
}

export interface CollectResult extends PageResult {
  pagesFetched: number;
  /**
   * Every outbound HTTP attempt, retries and error responses included.
   * Always >= pagesFetched. Instrumentation, not a billing figure — the
   * RapidAPI dashboard remains authoritative for quota.
   */
  providerRequests: number;
  truncated: boolean;
  outOfWindow: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Map an HTTP status to a classified error. Only 5xx is retryable here; every
 * 4xx is a deterministic client/config problem and is classified explicitly
 * rather than being swept into the retryable server_error bucket.
 */
function mapStatus(status: number, retryAfter: string | null, bodyHint: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError("auth", `Provider returned ${status}. Check RAPIDAPI_KEY.`, status);
  }
  if (status === 429) {
    const secs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    return new ProviderError("rate_limit", `Provider returned 429.`, status, secs);
  }
  if (status === 404) {
    // "the url was not found on Linkedin" — the identifier does not resolve.
    // Not transient: the source's rapidapi_identifier needs correcting.
    return new ProviderError(
      "source_not_found",
      `Provider returned 404: ${bodyHint}`,
      status,
    );
  }
  if (status >= 500) {
    return new ProviderError("server_error", `Provider returned ${status}: ${bodyHint}`, status);
  }
  if (status >= 400) {
    // Any other 4xx (400, 405, 410, 422, ...). A request-shape or config fault,
    // not a passing outage, so it is not retried.
    return new ProviderError("client_error", `Provider returned ${status}: ${bodyHint}`, status);
  }
  // Non-2xx that is neither 4xx nor 5xx (an unfollowed 3xx, say). Treat as a
  // non-retryable client error rather than silently retrying an unknown status.
  return new ProviderError("client_error", `Provider returned ${status}: ${bodyHint}`, status);
}

/**
 * One page, with retries. Returns the parsed page plus how many HTTP attempts
 * it cost — the caller adds that to provider_requests whether or not the page
 * ultimately succeeded.
 */
export async function fetchPage(
  linkedinUrl: string,
  start: number,
  opts: ProviderOptions,
): Promise<{ page: PageResult; attempts: number }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const host = opts.host ?? DEFAULT_HOST;
  const url = `https://${host}${COMPANY_POSTS_PATH}?linkedin_url=${encodeURIComponent(linkedinUrl)}&start=${start}`;

  let attempts = 0;
  let lastError: ProviderError | null = null;

  /** Stamp the real attempt count on the way out. Never MAX_ATTEMPTS. */
  const fail = (err: ProviderError): never => {
    err.attempts = attempts;
    throw err;
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { "x-rapidapi-key": opts.apiKey, "x-rapidapi-host": host },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const hint = (await res.text().catch(() => "")).slice(0, 200);
        const err = mapStatus(res.status, res.headers.get("Retry-After"), hint);
        if (!err.retryable || attempt === MAX_ATTEMPTS) fail(err);
        lastError = err;
        await sleep(Math.min(60_000, 4_000 * 2 ** (attempt - 1)));
        continue;
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        // HTTP 200 with an unusable body: one attempt, not retried.
        fail(new ProviderError("malformed_response", "Provider returned unparseable JSON.", res.status));
      }

      const raw = normalizePage(data);
      return {
        page: {
          posts: raw.posts,
          skippedNoId: raw.skippedNoId,
          skippedMalformed: raw.skippedMalformed,
          rawCount: raw.posts.length + raw.skippedNoId + raw.skippedMalformed,
        },
        attempts,
      };
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ProviderError) {
        if (!e.retryable || attempt === MAX_ATTEMPTS) fail(e);
        lastError = e;
      } else if (e instanceof DOMException && e.name === "AbortError") {
        const err = new ProviderError("timeout", `Request exceeded ${REQUEST_TIMEOUT_MS}ms.`);
        if (attempt === MAX_ATTEMPTS) fail(err);
        lastError = err;
      } else {
        const err = new ProviderError("network", `Network failure: ${(e as Error).message}`);
        if (attempt === MAX_ATTEMPTS) fail(err);
        lastError = err;
      }
      await sleep(Math.min(60_000, 4_000 * 2 ** (attempt - 1)));
    }
  }

  return fail(lastError ?? new ProviderError("network", "Exhausted attempts."));
}

/**
 * Page through one company until any stop condition trips:
 *   - a page comes back empty
 *   - every post on the page is older than the lookback window
 *   - the page repeats ids we have already seen (provider ignoring `start`)
 *   - MAX_PAGES reached -> truncated = true
 *   - the caller's overall time budget is spent -> budget_exhausted
 *
 * providerRequests accumulates across every attempt, including the attempts
 * belonging to a page that eventually threw.
 */
export async function collectCompanyPosts(
  linkedinUrl: string,
  lookbackDays: number,
  opts: ProviderOptions & { deadline?: number },
): Promise<CollectResult> {
  const now = opts.now ?? (() => new Date());
  const seen = new Set<string>();
  const posts: NormalizedPost[] = [];

  let pagesFetched = 0;
  let providerRequests = 0;
  let skippedNoId = 0;
  let skippedMalformed = 0;
  let outOfWindow = 0;
  let truncated = false;
  let rawCount = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      throw new ProviderError("budget_exhausted", "Execution budget exhausted mid-source.");
    }

    let result: { page: PageResult; attempts: number };
    try {
      result = await fetchPage(linkedinUrl, page * 50, opts);
    } catch (e) {
      // Failed attempts still cost quota. Add the attempts actually made — a
      // 401 costs one, an exhausted 500 retry costs three — so the recorded
      // figure matches what the provider really saw.
      if (e instanceof ProviderError) {
        e.providerRequests = providerRequests + (e.attempts || 1);
      }
      throw e;
    }

    providerRequests += result.attempts;
    skippedNoId += result.page.skippedNoId;
    skippedMalformed += result.page.skippedMalformed;
    rawCount += result.page.rawCount;

    if (result.page.rawCount === 0) break;          // empty page
    pagesFetched++;

    const fresh = result.page.posts.filter((p) => !seen.has(p.externalPostId));
    if (fresh.length === 0) break;                   // page repeated

    let anyInWindow = false;
    for (const p of fresh) {
      seen.add(p.externalPostId);
      if (isWithinLookback(p.publishedAt, lookbackDays, now())) {
        posts.push(p);
        anyInWindow = true;
      } else {
        outOfWindow++;
      }
    }

    if (!anyInWindow) break;                         // whole page older than window

    if (page === MAX_PAGES - 1) truncated = true;    // cap reached
  }

  return {
    posts,
    skippedNoId,
    skippedMalformed,
    rawCount,
    pagesFetched,
    providerRequests,
    truncated,
    outOfWindow,
  };
}

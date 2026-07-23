/** Error codes mirrored from ingest_run_sources.error_code (0003 + 0004). */
export type IngestErrorCode =
  | "disabled"
  | "no_rapidapi_identifier"
  | "locked"
  | "stale_lock"
  | "auth"
  | "auth_aborted"
  | "rate_limit"
  | "server_error"
  | "network"
  | "malformed_response"
  | "timeout"
  | "budget_exhausted"
  // Provider 404: the identifier does not resolve. Non-retryable — the source
  // config is wrong and no amount of retrying fixes it.
  | "source_not_found"
  // Any other 4xx: a request/config problem, not a transient outage.
  | "client_error";

export class ProviderError extends Error {
  /**
   * HTTP attempts actually made before this error was raised. Set by fetchPage
   * on every throw path and accumulated by the caller into provider_requests.
   *
   * It must be the real count, never inferred from MAX_ATTEMPTS: a 401, a 429
   * and a malformed body all fail on the first attempt, and recording three
   * would overstate consumption in exactly the cases we most want to trust.
   */
  attempts = 0;

  /** Running total for the whole source, attached when the error escapes. */
  providerRequests?: number;

  constructor(
    readonly code: IngestErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /**
   * Whether another attempt could plausibly succeed. ONLY genuinely transient
   * failures qualify: 5xx, network drops and timeouts.
   *
   * Everything else — auth, rate limits, 404s, other 4xx, malformed bodies — is
   * deterministic given the same request, so retrying only burns quota to learn
   * the same thing. A bad identifier that returned 404 three times (once in the
   * legacy scraper, once in our first dry run) is exactly what this guards
   * against.
   */
  get retryable(): boolean {
    return this.code === "server_error" || this.code === "network" ||
      this.code === "timeout";
  }

  /** Terminal status to record for the source. */
  get sourceStatus(): "failed" | "rate_limited" | "auth_failed" {
    if (this.code === "auth") return "auth_failed";
    if (this.code === "rate_limit") return "rate_limited";
    return "failed";
  }
}

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/** Error codes mirrored from ingest_run_sources.error_code in 0003_ingest.sql. */
export type IngestErrorCode =
  | "disabled"
  | "no_rapidapi_identifier"
  | "locked"
  | "stale_lock"
  | "auth"
  | "rate_limit"
  | "server_error"
  | "network"
  | "malformed_response"
  | "timeout"
  | "budget_exhausted";

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
   * Whether another attempt could plausibly succeed.
   *
   * `auth` is not retryable on purpose: a bad key fails identically every time,
   * and retrying it across four sources burns quota to learn nothing.
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

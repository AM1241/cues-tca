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

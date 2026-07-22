/**
 * Request parsing and server-side bounds.
 *
 * Every limit here is enforced on the server. The UI may also enforce them, but
 * the UI is not a security control: this function spends metered provider quota
 * and is reachable by anyone holding a valid editor token.
 */
import { RequestError } from "../_shared/errors.ts";

export const LOOKBACK_MIN = 1;
export const LOOKBACK_MAX = 90;
export const MAX_SOURCES_PER_RUN = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IngestRequest {
  sourceIds: string[] | null; // null = every enabled source
  lookbackOverride: number | null;
  dryRun: boolean;
}

export function parseRequest(body: unknown): IngestRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "Body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;

  // ---- source_ids --------------------------------------------------------
  let sourceIds: string[] | null = null;
  if (b.source_ids !== undefined && b.source_ids !== null) {
    if (!Array.isArray(b.source_ids)) {
      throw new RequestError(400, "source_ids must be an array of uuids.");
    }
    if (b.source_ids.length === 0) {
      throw new RequestError(400, "source_ids must not be empty; omit it to collect every enabled source.");
    }
    if (b.source_ids.length > MAX_SOURCES_PER_RUN) {
      throw new RequestError(400, `source_ids may not exceed ${MAX_SOURCES_PER_RUN} entries.`);
    }
    for (const id of b.source_ids) {
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        throw new RequestError(400, `source_ids contains a value that is not a uuid: ${String(id)}`);
      }
    }
    sourceIds = [...new Set(b.source_ids as string[])];
  }

  // ---- lookback_days -----------------------------------------------------
  let lookbackOverride: number | null = null;
  if (b.lookback_days !== undefined && b.lookback_days !== null) {
    const n = b.lookback_days;
    if (typeof n !== "number" || !Number.isInteger(n)) {
      throw new RequestError(400, "lookback_days must be an integer.");
    }
    if (n < LOOKBACK_MIN || n > LOOKBACK_MAX) {
      throw new RequestError(400, `lookback_days must be between ${LOOKBACK_MIN} and ${LOOKBACK_MAX}.`);
    }
    lookbackOverride = n;
  }

  // ---- dry_run -----------------------------------------------------------
  // NOT a test mechanism: it still calls the provider and still spends quota.
  // It only skips the database writes.
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") {
    throw new RequestError(400, "dry_run must be a boolean.");
  }

  return { sourceIds, lookbackOverride, dryRun: b.dry_run === true };
}

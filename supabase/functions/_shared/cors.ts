/**
 * CORS. Deliberately no wildcard.
 *
 * `Access-Control-Allow-Origin: *` on a function that spends metered provider
 * quota lets any page on the internet trigger a collection run. Origins are an
 * explicit allowlist from ALLOWED_ORIGINS (comma-separated); an unlisted origin
 * gets no CORS headers back and the browser blocks the response.
 *
 * This is defence in depth, not the security boundary — CORS is enforced by
 * browsers only. Authentication in auth.ts is the actual control.
 */

const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export function allowedOrigins(): string[] {
  const raw = Deno.env.get("ALLOWED_ORIGINS")?.trim();
  if (!raw) return DEFAULT_ORIGINS;
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

/** CORS headers for an allowed origin; empty object otherwise. */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

/**
 * Answer a preflight without authenticating and without starting a run.
 * Returns null for non-OPTIONS requests.
 */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("Origin");
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

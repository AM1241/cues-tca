/**
 * Who is calling, and may they spend provider quota?
 *
 * The function runs with `verify_jwt = false`, so this module IS the gate —
 * nothing upstream has checked anything. That is deliberate: the platform's
 * built-in verify_jwt only understands JWTs, and internal callers authenticate
 * with an opaque secret, which the gateway would reject before our code ever
 * ran.
 *
 * Two, and only two, ways in:
 *
 *   internal — a dedicated secret in the `apikey` header. Used by pg_cron and
 *              by backfill jobs. Never present in a browser.
 *   editor   — a real end-user access token in `Authorization: Bearer`,
 *              verified by calling auth.getUser(), then required to be present
 *              in public.editors with role 'admin'.
 *
 * Rules this file exists to enforce:
 *   - No decoded-but-unverified JWT claim ever selects the auth path. The old
 *     version read `role` out of an unverified token; a forged claim is free to
 *     produce, so that was a decision made on attacker-supplied data.
 *   - The service-role key is NOT a caller credential. It is only ever used to
 *     build the internal database client (see db.ts). A leaked service key must
 *     not become a way to trigger collection.
 *   - trigger_source is derived here, from the credential. A browser caller is
 *     always 'manual' regardless of what the body claims.
 */
import { createClient } from "jsr:@supabase/supabase-js@2.110.8";
import { RequestError } from "./errors.ts";

export type Actor =
  | { kind: "internal"; triggerSource: "cron" | "backfill" }
  | {
    kind: "editor";
    triggerSource: "manual";
    userId: string;
    email: string;
    role: string;
  };

/** Constant-time comparison; a length-independent early return leaks nothing useful. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticate(
  req: Request,
  body: { trigger_source?: unknown },
): Promise<Actor> {
  // ---- internal: cron / backfill -----------------------------------------
  const internalSecret = Deno.env.get("INGEST_INTERNAL_SECRET") ?? "";
  const providedKey = req.headers.get("apikey") ?? "";
  if (internalSecret && providedKey && secretsMatch(providedKey, internalSecret)) {
    const requested = body.trigger_source;
    return {
      kind: "internal",
      triggerSource: requested === "backfill" ? "backfill" : "cron",
    };
  }

  // ---- end user: always manual -------------------------------------------
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new RequestError(401, "Missing credentials.");

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) throw new RequestError(500, "Function environment incomplete.");

  // Act as the caller: the token is verified by Auth, and the editors lookup is
  // then subject to RLS rather than to our own logic.
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) throw new RequestError(401, "Invalid or expired token.");

  const user = userData.user;
  const { data: editor, error: editorErr } = await asUser
    .from("editors")
    .select("user_id, email, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (editorErr) throw new RequestError(403, "Not authorised.");
  if (!editor) throw new RequestError(403, "Not on the editors allowlist.");

  if (editor.role !== "admin") {
    throw new RequestError(
      403,
      "Collection is restricted to admin editors while provider quota is being measured.",
    );
  }

  return {
    kind: "editor",
    triggerSource: "manual",
    userId: user.id,
    email: editor.email ?? user.email ?? "",
    role: editor.role,
  };
}

/**
 * Who is calling, and may they spend provider quota?
 *
 * Two kinds of caller:
 *   service — an internal invocation holding the service role key (cron,
 *             backfill). Never reachable from a browser.
 *   editor  — a signed-in user. Their JWT is checked against public.editors.
 *
 * trigger_source is derived HERE, from the credential, and never read from the
 * request body. A browser caller is always 'manual' no matter what it claims.
 *
 * For the first live version only editors with role = 'admin' may trigger
 * collection, because every invocation costs metered quota. Relax once real
 * usage has been measured.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { RequestError } from "./errors.ts";

export type Actor =
  | { kind: "service"; triggerSource: "cron" | "backfill" }
  | {
    kind: "editor";
    triggerSource: "manual";
    userId: string;
    email: string;
    role: string;
  };

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const pad = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(pad + "=".repeat((4 - pad.length % 4) % 4)));
  } catch {
    return null;
  }
}

export async function authenticate(
  req: Request,
  body: { trigger_source?: unknown },
): Promise<Actor> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new RequestError(401, "Missing bearer token.");

  // ---- service role: cron / backfill -------------------------------------
  // Exact-match the configured key first. Supabase issues both legacy JWT
  // service keys and the newer opaque `sb_secret_...` form; only the JWT one
  // carries a decodable role claim, so matching the key itself is the check
  // that works for both.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (serviceKey && token === serviceKey) {
    const requested = body.trigger_source;
    const triggerSource = requested === "backfill" ? "backfill" : "cron";
    return { kind: "service", triggerSource };
  }

  // A token *claiming* service_role that is not the configured key is a forgery
  // attempt, not a user session. Refuse rather than falling through.
  const claims = decodeJwtPayload(token);
  if (typeof claims?.role === "string" && claims.role === "service_role") {
    throw new RequestError(401, "Invalid service credential.");
  }

  // ---- end user: always manual -------------------------------------------
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) throw new RequestError(500, "Function environment incomplete.");

  // Act as the caller so RLS, not our own logic, decides what they can read.
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

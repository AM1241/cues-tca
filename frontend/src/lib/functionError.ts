/**
 * What an Edge Function actually said when it refused.
 *
 * `supabase.functions.invoke` reports EVERY non-2xx as a `FunctionsHttpError`
 * whose `.message` is the constant string "Edge Function returned a non-2xx
 * status code". Meanwhile every function in this project answers with
 * `{ ok: false, error: "<reason>" }` and a real status — so the reason exists,
 * is written for a human, and was being thrown away by every
 * `toast.error(error.message)` in the app.
 *
 * The cost of that was not theoretical. A manager trialling the tool pressed
 * Collect, was refused because his account is not an admin, and saw only the
 * constant. He reported "Collect is broken" — both true and useless, because
 * the sentence that would have explained it never left the server.
 *
 * The body lives on `error.context`, a `Response`, and a Response body can only
 * be read ONCE. That is why this returns a promise, and why a caller must await
 * it exactly once per error object.
 */

/** The placeholder supabase-js uses for any non-2xx. Never worth showing. */
const GENERIC_HTTP_MESSAGE = 'Edge Function returned a non-2xx status code'

/**
 * The network-level failure, which reads like a missing function but is almost
 * always a blocked origin. Session 20 lost time to exactly this: Vite moves to
 * port 5174 when 5173 is taken, and production `ALLOWED_ORIGINS` lists only
 * 5173.
 */
const FETCH_FAILURE_MESSAGE = 'Failed to send a request to the Edge Function'

/** Used only when the body could not be read — better than a bare number. */
function statusLine(status: number): string {
  if (status === 401) return 'Your session is no longer valid — sign out and sign in again'
  if (status === 403) return 'Your account is not allowed to do this'
  if (status === 404) return 'That function is not deployed'
  if (status === 429) return 'Too many requests — wait a moment and try again'
  if (status >= 500) return 'The server failed while handling this'
  return 'The request was refused'
}

function parseErrorField(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    return typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : null
  } catch {
    return null
  }
}

/**
 * Best available human explanation for a failed `functions.invoke`.
 *
 * @param error    the `error` from `{ data, error }`
 * @param fallback shown only when nothing better can be recovered
 */
export async function functionErrorMessage(
  error: unknown,
  fallback = 'The request failed.',
): Promise<string> {
  const err = error as { message?: unknown; context?: unknown } | null | undefined
  const context = err?.context

  if (context instanceof Response) {
    // A caller that already consumed the body gets the status line rather than
    // a TypeError thrown from inside error handling.
    if (!context.bodyUsed) {
      try {
        const text = (await context.text()).trim()
        const fromJson = parseErrorField(text)
        if (fromJson) return fromJson
        // A non-JSON body is still more informative than the constant, as long
        // as it is short enough to be a message and not an HTML error page.
        if (text && text.length <= 300 && !text.startsWith('<')) return text
      } catch {
        // Body unreadable (already consumed elsewhere, or a stream error).
        // Fall through to the status line.
      }
    }
    return `${statusLine(context.status)} (HTTP ${context.status}).`
  }

  const raw = typeof err?.message === 'string' ? err.message.trim() : ''

  if (raw === FETCH_FAILURE_MESSAGE) {
    return `${raw} — the browser could not reach it. On a dev server, check the port is one that ALLOWED_ORIGINS lists.`
  }
  if (raw && raw !== GENERIC_HTTP_MESSAGE) return raw
  return fallback
}

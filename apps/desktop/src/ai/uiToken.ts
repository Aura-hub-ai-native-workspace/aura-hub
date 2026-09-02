/**
 * uiToken — how this window proves it is this window.
 * ------------------------------------------------------------------
 * The service mints a token each boot and writes it where only the user
 * can read it; the Rust shell reads it back through the `ui_token`
 * command. Presenting it on a request tells the service the call came
 * from AURA's own UI rather than from something else on the machine —
 * which is what lets a deliberate click count as the user's consent
 * instead of raising an approval the same user then has to answer.
 *
 * Mirrors `fsClient.ts`: the bridge only exists inside the Tauri webview.
 * In browser preview (`npm run dev` with no Rust) there is none, so this
 * returns null, no header is sent, and every action travels the full
 * governed path. Failing to the *stricter* behaviour is the only
 * acceptable direction for this file to fail in.
 */

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeRef: Invoke | null | undefined;
/** Resolved once and reused: the token is stable for the service's life. */
let cached: string | null | undefined;

async function getInvoke(): Promise<Invoke | null> {
  if (invokeRef !== undefined) return invokeRef;
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    invokeRef = null;
    return invokeRef;
  }
  try {
    const mod = await import('@tauri-apps/api/core');
    invokeRef = mod.invoke as Invoke;
  } catch {
    invokeRef = null;
  }
  return invokeRef;
}

/**
 * This boot's token, or null when there is no shell to ask.
 *
 * A null result is cached only once the shell has answered — a failed
 * read while the service is still starting is retried on the next call,
 * so the first click after launch does not permanently downgrade the
 * window to untrusted.
 */
export async function uiToken(): Promise<string | null> {
  if (cached !== undefined) return cached;
  const invoke = await getInvoke();
  if (!invoke) {
    cached = null;
    return cached;
  }
  try {
    const value = await invoke<string | null>('ui_token');
    if (!value) return null; // not cached — the service may still be booting
    cached = value;
    return cached;
  } catch {
    return null;
  }
}

/**
 * Request headers for a deliberate user action.
 *
 * Callers pass the result straight into `fetch`. When there is no token
 * the object is empty, which is the ordinary governed request.
 */
export async function userActionHeaders(): Promise<Record<string, string>> {
  const token = await uiToken();
  return token ? { 'x-aura-ui': token } : {};
}

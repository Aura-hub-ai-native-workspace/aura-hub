/**
 * Errors that reach the top of the window are written to a local crash
 * record by the desktop shell (src-tauri/src/crash.rs). Nothing is sent
 * anywhere. Outside the desktop app this does nothing.
 */

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function inDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!inDesktop()) return null;
  try {
    const mod = await import('@tauri-apps/api/core');
    return await (mod.invoke as Invoke)<T>(cmd, args);
  } catch {
    return null;
  }
}

/** The same error twice in a row is recorded once (render loops repeat). */
let last = '';

export function recordError(kind: string, error: unknown, extra?: string): void {
  const e = error instanceof Error ? error : new Error(String(error));
  const key = `${kind}:${e.message}`;
  if (key === last) return;
  last = key;
  const stack = [e.stack, extra].filter(Boolean).join('\n\n');
  void invoke('record_renderer_error', { kind, message: e.message, stack: stack || null });
}

export function installCrashRecording(): void {
  if (!inDesktop()) return;
  window.addEventListener('error', (ev) => recordError('error', ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => recordError('unhandled-rejection', ev.reason));
}

export interface CrashRecord { file: string; atMs: number; source: string; summary: string }

export async function listCrashRecords(): Promise<CrashRecord[] | null> {
  return invoke<CrashRecord[]>('list_crash_records');
}

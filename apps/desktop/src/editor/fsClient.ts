/**
 * fsClient — the Code Workspace's only door to the real filesystem.
 * ------------------------------------------------------------------
 * Real disk access is only possible inside the Tauri webview (the fs
 * commands live in src-tauri, not the Node ai-service backend, so this
 * stays entirely inside apps/desktop). In plain browser preview
 * (`npm run dev` with no Rust), there is no bridge, so every call here
 * fails with a clear, honest error instead of pretending to succeed.
 */
import type { FileTreeNode } from './editorTypes';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const NO_DESKTOP_MESSAGE = 'Desktop file access is unavailable in browser preview. Run `npm run tauri dev` to edit real files.';

let invokeRef: Invoke | null | undefined;

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

export async function isDesktopFsAvailable(): Promise<boolean> {
  return (await getInvoke()) !== null;
}

export async function fsReadDir(root: string, relPath: string): Promise<FileTreeNode[]> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error(NO_DESKTOP_MESSAGE);
  return invoke<FileTreeNode[]>('code_read_dir', { root, relPath });
}

export async function fsReadFile(root: string, relPath: string): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error(NO_DESKTOP_MESSAGE);
  return invoke<string>('code_read_file', { root, relPath });
}

export async function fsWriteFile(root: string, relPath: string, contents: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error(NO_DESKTOP_MESSAGE);
  return invoke<void>('code_write_file', { root, relPath, contents });
}

/** Creates a brand-new file (e.g. an AI-generated test file). Never clobbers an existing one. */
export async function fsCreateFile(root: string, relPath: string, contents: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) throw new Error(NO_DESKTOP_MESSAGE);
  return invoke<void>('code_create_file', { root, relPath, contents });
}

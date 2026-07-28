/**
 * Safe file reader.
 * ==================================================================
 * Reads real files defensively:
 *   • caps very large files at a byte limit (content truncated, flagged)
 *   • detects binary files (NUL bytes / high non-text ratio) and skips
 *     their content
 *   • tolerates invalid UTF-8 (counts replacement chars; treats heavily
 *     mojibake'd files as binary)
 *   • turns permission / IO errors into typed results, never throws
 */

import { open } from 'node:fs/promises';
import { sha1 } from './checksum';

export interface ReadResult {
  ok: boolean;
  text?: string;
  bytesRead: number;
  truncated: boolean;
  binary: boolean;
  lines: number;
  checksum: string;
  error?: { code: string; message: string };
}

const SNIFF = 8192;

/** Heuristic binary detection over a byte sample. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, SNIFF);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true; // NUL → definitely binary
    // control chars outside tab/newline/carriage-return/formfeed/esc
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n > 0.3;
}

/** Ratio of Unicode replacement chars after a lossy UTF-8 decode. */
function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let bad = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
  return bad / text.length;
}

export async function readFileSafe(absPath: string, maxBytes: number): Promise<ReadResult> {
  let handle;
  try {
    handle = await open(absPath, 'r');
    const stat = await handle.stat();
    const size = stat.size;
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(toRead);
    let offset = 0;
    // Read in a loop — a single read() may return fewer bytes.
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = offset === toRead ? buf : buf.subarray(0, offset);
    const checksum = sha1(bytes);

    if (looksBinary(bytes)) {
      return { ok: true, bytesRead: offset, truncated: size > maxBytes, binary: true, lines: 0, checksum };
    }

    const text = bytes.toString('utf8');
    if (replacementRatio(text) > 0.1) {
      return { ok: true, bytesRead: offset, truncated: size > maxBytes, binary: true, lines: 0, checksum };
    }

    let lines = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;

    return { ok: true, text, bytesRead: offset, truncated: size > maxBytes, binary: false, lines, checksum };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      bytesRead: 0,
      truncated: false,
      binary: false,
      lines: 0,
      checksum: '',
      error: { code: e.code ?? 'EUNKNOWN', message: e.message ?? String(err) },
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

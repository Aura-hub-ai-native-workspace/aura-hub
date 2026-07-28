/**
 * CodeChunker — splits a document into contiguous semantic chunks.
 * ==================================================================
 * Line-window chunking that prefers to break on blank lines (natural
 * boundaries between functions/blocks/paragraphs), tracks precise
 * 1-based line ranges AND byte ranges, estimates tokens, and extracts
 * light symbols (declarations, headings) for boosting. No overlap —
 * adjacent context is provided by neighbor-chunk retrieval instead.
 */

import { estimateTokens } from '@aura/retrieval/types';
import type { CodeChunk, CodeDocument } from './types';

export interface ChunkOptions {
  maxLines?: number;
  maxChars?: number;
  /** How far back to look for a blank-line boundary before force-cutting. */
  lookback?: number;
}

const DECL = /\b(function|class|interface|type|enum|struct|impl|trait|module|namespace|const|let|var|def|fn|func|public|private|export)\s+([A-Za-z_$][\w$]*)/g;
const HEADING = /^#{1,6}\s+(.+?)\s*$/;

function extractSymbols(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(text)) && out.size < 12) {
    if (m[2] && m[2].length > 1) out.add(m[2]);
  }
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line);
    if (h && out.size < 12) out.add(h[1].trim());
  }
  return [...out];
}

export function chunkDocument(doc: CodeDocument, text: string, opts: ChunkOptions = {}): CodeChunk[] {
  const maxLines = opts.maxLines ?? 60;
  const maxChars = opts.maxChars ?? 1600;
  const lookback = opts.lookback ?? 10;

  const lines = text.split('\n');
  const n = lines.length;

  // Byte offset at the start of each line (line i occupies [byteStart[i], byteStart[i+1]-1] incl. its '\n').
  const byteStart = new Array<number>(n + 1);
  byteStart[0] = 0;
  for (let i = 0; i < n; i++) {
    byteStart[i + 1] = byteStart[i] + Buffer.byteLength(lines[i], 'utf8') + (i < n - 1 ? 1 : 0);
  }

  const chunks: CodeChunk[] = [];
  let s = 0;
  let ordinal = 0;

  while (s < n) {
    let chars = 0;
    let i = s;
    for (; i < n; i++) {
      chars += lines[i].length + 1;
      if (i - s + 1 >= maxLines || chars >= maxChars) break;
    }
    let end = Math.min(i, n - 1);

    // Prefer a nearby blank line as the boundary.
    if (end < n - 1) {
      const floor = Math.max(s + Math.floor(maxLines / 3), end - lookback);
      for (let j = end; j >= floor; j--) {
        if (lines[j].trim() === '') {
          end = j;
          break;
        }
      }
    }
    if (end < s) end = s;

    const text2 = lines.slice(s, end + 1).join('\n');
    if (text2.trim().length > 0) {
      chunks.push({
        id: `${doc.id}#${ordinal}`,
        documentId: doc.id,
        ordinal,
        text: text2,
        startLine: s + 1,
        endLine: end + 1,
        startByte: byteStart[s],
        endByte: byteStart[end + 1],
        tokenEstimate: estimateTokens(text2),
        language: doc.language,
        relPath: doc.relPath,
        symbols: extractSymbols(text2),
      });
      ordinal++;
    }
    s = end + 1;
  }

  return chunks;
}

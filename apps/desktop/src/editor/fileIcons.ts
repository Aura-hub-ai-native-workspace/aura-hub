/**
 * Extension → language / color. AURA's icon set is deliberately a single
 * bespoke hand (see packages/ui/src/icons/Icon.tsx) rather than a large
 * per-language icon pack, so a file's *kind* is read from a small color
 * dot next to a generic file glyph — same spirit as VS Code's file
 * icons, without importing a whole foreign icon language into AURA.
 */

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  rs: 'rust',
  py: 'python',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  txt: 'plaintext',
  env: 'plaintext',
};

function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Monaco language id for a file's contents, by extension. */
export function languageFromPath(path: string): string {
  return EXT_LANGUAGE[extOf(path)] ?? 'plaintext';
}

const EXT_COLOR: Record<string, string> = {
  ts: '#3b82f6',
  tsx: '#3b82f6',
  js: '#eab308',
  jsx: '#eab308',
  mjs: '#eab308',
  cjs: '#eab308',
  json: '#ca8a04',
  md: '#94a3b8',
  mdx: '#94a3b8',
  css: '#2563eb',
  scss: '#db2777',
  less: '#db2777',
  html: '#ea580c',
  rs: '#dc7633',
  py: '#3572a5',
  go: '#06b6d4',
  yml: '#a855f7',
  yaml: '#a855f7',
  toml: '#9a3412',
  rb: '#dc2626',
  java: '#dc2626',
};

/** A small color dot standing in for a file-type icon. */
export function colorForPath(path: string): string {
  return EXT_COLOR[extOf(path)] ?? 'var(--text-subtle)';
}

/** Short label for the file's kind, shown in the AI Context panel. */
export function labelForLanguage(language: string): string {
  if (language === 'plaintext') return 'Plain Text';
  if (language === 'typescript') return 'TypeScript';
  if (language === 'javascript') return 'JavaScript';
  return language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * Language & file-kind detection.
 * ==================================================================
 * Real detection by extension and by well-known filenames (README,
 * LICENSE, Dockerfile, Makefile, .gitignore, package manifests, …).
 * Deterministic, no guessing beyond declared rules.
 */

import type { FileKind, LanguageId } from './types';

const EXT_LANG: Record<string, LanguageId> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.json': 'json', '.jsonc': 'jsonc', '.json5': 'jsonc',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
  '.xml': 'xml', '.sql': 'sql',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown', '.txt': 'text', '.text': 'text',
  '.rs': 'rust', '.py': 'python', '.pyi': 'python', '.go': 'go', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.kts': 'kotlin',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'scss', '.html': 'html', '.htm': 'html',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.env': 'env',
};

/** Exact filenames (case-insensitive) → language. */
const NAME_LANG: Record<string, LanguageId> = {
  'dockerfile': 'dockerfile', 'containerfile': 'dockerfile',
  'makefile': 'makefile', 'gnumakefile': 'makefile',
  '.gitignore': 'gitignore', '.dockerignore': 'gitignore', '.npmignore': 'gitignore', '.eslintignore': 'gitignore', '.prettierignore': 'gitignore',
  '.env': 'env', '.env.local': 'env', '.env.example': 'env',
  'license': 'license', 'license.md': 'license', 'license.txt': 'license', 'licence': 'license', 'copying': 'license',
};

/** Manifest / build filenames → treated as manifest kind. */
const MANIFEST_NAMES = new Set([
  'package.json', 'tsconfig.json', 'tsconfig.base.json', 'pnpm-workspace.yaml', 'cargo.toml', 'go.mod', 'go.sum',
  'pyproject.toml', 'requirements.txt', 'pipfile', 'gemfile', 'composer.json', 'pom.xml', 'build.gradle',
  'vite.config.ts', 'vite.config.js', 'tailwind.config.ts', 'postcss.config.js', 'rollup.config.js', 'webpack.config.js',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile',
]);

const DOC_LANGS = new Set<LanguageId>(['markdown', 'text']);
const CONFIG_LANGS = new Set<LanguageId>(['yaml', 'toml', 'ini', 'xml', 'json', 'jsonc', 'env']);
const CODE_LANGS = new Set<LanguageId>([
  'typescript', 'javascript', 'tsx', 'jsx', 'rust', 'python', 'go', 'java', 'c', 'cpp',
  'csharp', 'ruby', 'php', 'swift', 'kotlin', 'css', 'scss', 'html', 'shell', 'sql', 'dockerfile', 'makefile',
]);

export function detectLanguage(name: string, ext: string): LanguageId {
  const lower = name.toLowerCase();
  if (NAME_LANG[lower]) return NAME_LANG[lower];
  if (lower.startsWith('.env')) return 'env';
  if (lower.startsWith('license') || lower.startsWith('licence')) return 'license';
  if (lower.startsWith('readme')) return 'markdown';
  return EXT_LANG[ext.toLowerCase()] ?? 'unknown';
}

export function detectKind(name: string, language: LanguageId): FileKind {
  const lower = name.toLowerCase();
  if (language === 'license') return 'license';
  if (language === 'gitignore') return 'ignore';
  if (MANIFEST_NAMES.has(lower)) return 'manifest';
  if (CODE_LANGS.has(language)) return 'code';
  if (DOC_LANGS.has(language)) return 'doc';
  if (CONFIG_LANGS.has(language)) return 'config';
  if (language === 'sql') return 'data';
  if (language === 'unknown') return 'unknown';
  return 'text';
}

/** The full set of languages/kinds the Coding engine will index (content). */
export function isIndexableLanguage(language: LanguageId): boolean {
  return language !== 'binary' && language !== 'unknown';
}

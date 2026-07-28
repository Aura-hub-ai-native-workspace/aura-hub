/**
 * Project profiler — real, derived understanding of a folder.
 * ==================================================================
 * Walks the actual project directory and reports only what is really
 * there: languages (by file extension), package manager, frameworks and
 * dependencies (from real manifests), and whether the project has a
 * frontend / backend / database / config / git / docker / CI surface.
 *
 * Nothing here is invented. A field is absent or empty when the signal
 * is not present in the folder. The profile is cached to disk and only
 * regenerated when the folder's fingerprint (manifest mtimes) changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from './persist';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.turbo', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.aura',
  '.aura-index', '.aura-fullstack', '.idea', '.vscode',
]);

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.rb': 'Ruby',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cs': 'C#', '.php': 'PHP',
  '.scala': 'Scala', '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart',
  '.vue': 'Vue', '.svelte': 'Svelte', '.sql': 'SQL', '.sh': 'Shell',
  '.css': 'CSS', '.scss': 'CSS', '.html': 'HTML', '.md': 'Markdown',
};

const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@angular/core': 'Angular', '@sveltejs/kit': 'SvelteKit',
  express: 'Express', '@nestjs/core': 'NestJS', '@nestjs/common': 'NestJS', '@nestjs/platform-express': 'NestJS', fastify: 'Fastify', koa: 'Koa',
  '@tauri-apps/api': 'Tauri', electron: 'Electron', vite: 'Vite', webpack: 'Webpack',
  tailwindcss: 'Tailwind CSS', typeorm: 'TypeORM', prisma: 'Prisma', sequelize: 'Sequelize',
  mongoose: 'Mongoose', django: 'Django', flask: 'Flask', fastapi: 'FastAPI',
  '@aura/core': 'AURA', zustand: 'Zustand', 'framer-motion': 'Framer Motion',
};

const DB_DEPS = new Set(['pg', 'postgres', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongodb', 'mongoose', 'redis', 'ioredis', 'typeorm', 'prisma', 'sequelize', 'drizzle-orm']);

export interface FolderNode {
  name: string;
  files: number;
  dirs: number;
}

export interface ProjectProfile {
  id: string;
  path: string;
  generatedAt: string;
  fingerprint: string;
  type: string;
  primaryLanguage: string;
  languages: { name: string; files: number }[];
  packageManager: string | null;
  frameworks: string[];
  dependencies: { name: string; version: string; kind: 'runtime' | 'dev' }[];
  has: {
    frontend: boolean;
    backend: boolean;
    database: boolean;
    config: boolean;
    git: boolean;
    docker: boolean;
    ci: boolean;
    tests: boolean;
  };
  structure: FolderNode[];
  architectureDocs: { title: string; relPath: string }[];
  fileCount: number;
  summary: string;
  /* enriched, evolving profile fields (all derived from real files) */
  purpose: string;
  entryPoints: string[];
  buildSystem: string | null;
  importantFiles: string[];
  codingStyle: { indent: string; quotes: string; semicolons: boolean } | null;
}

/** Bump when the profile shape changes so cached profiles regenerate. */
const PROFILE_VERSION = 2;

const PROFILE_FILE = (id: string) => homePath('profiles', `${id}.json`);

function safeStatMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** A cheap fingerprint over the manifests that define the project shape. */
function fingerprint(root: string): string {
  const markers = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile', 'composer.json', 'Dockerfile'];
  return `v${PROFILE_VERSION}|` + markers.map((m) => `${m}:${safeStatMtime(path.join(root, m))}`).join('|');
}

function exists(root: string, rel: string): boolean {
  try { return fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile(); } catch { return false; }
}

/** Derive a one-line purpose from README heading/first prose or manifest description. */
function derivePurpose(root: string, pkgDesc?: string): string {
  const readme = path.join(root, 'README.md');
  if (fs.existsSync(readme)) {
    try {
      const lines = fs.readFileSync(readme, 'utf8').split('\n').map((l) => l.trim());
      const prose = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('![') && !l.startsWith('[!') && !l.startsWith('<'));
      if (prose) return prose.replace(/[*_`]/g, '').slice(0, 240);
      const heading = lines.find((l) => l.startsWith('# '));
      if (heading) return heading.replace(/^#\s*/, '').slice(0, 240);
    } catch { /* ignore */ }
  }
  return pkgDesc?.slice(0, 240) ?? '';
}

function deriveEntryPoints(root: string, pkg: { main?: string; module?: string; bin?: unknown; scripts?: Record<string, string> } | null): string[] {
  const out = new Set<string>();
  for (const c of ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts', 'src/App.tsx', 'index.js', 'index.ts', 'main.py', 'app.py', 'src/main.py', 'cmd/main.go', 'main.go', 'src/main.rs']) if (exists(root, c)) out.add(c);
  if (pkg?.main && exists(root, pkg.main)) out.add(pkg.main);
  if (pkg?.module && exists(root, pkg.module)) out.add(pkg.module);
  return [...out].slice(0, 8);
}

function deriveBuildSystem(root: string): string | null {
  if (exists(root, 'vite.config.ts') || exists(root, 'vite.config.js')) return 'Vite';
  if (exists(root, 'next.config.js') || exists(root, 'next.config.mjs')) return 'Next.js';
  if (exists(root, 'webpack.config.js')) return 'Webpack';
  if (exists(root, 'rollup.config.js')) return 'Rollup';
  if (exists(root, 'tsconfig.json')) return 'TypeScript (tsc)';
  if (exists(root, 'Makefile')) return 'Make';
  if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) return 'Gradle';
  if (exists(root, 'pom.xml')) return 'Maven';
  if (exists(root, 'Cargo.toml')) return 'Cargo';
  if (exists(root, 'go.mod')) return 'Go build';
  if (exists(root, 'pyproject.toml') || exists(root, 'setup.py')) return 'Python build';
  return null;
}

function deriveImportantFiles(root: string, entryPoints: string[]): string[] {
  const out = new Set<string>(entryPoints);
  for (const c of ['README.md', 'package.json', 'tsconfig.json', 'ARCHITECTURE.md', 'docs/ARCHITECTURE.md', 'Dockerfile', 'docker-compose.yml', '.env.example', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml']) if (exists(root, c)) out.add(c);
  return [...out].slice(0, 14);
}

/** Sample a few real source files to infer the dominant coding style. */
function deriveCodingStyle(root: string, entryPoints: string[]): ProjectProfile['codingStyle'] {
  const samples = [...entryPoints, 'src/index.ts', 'src/main.ts'].filter((f, i, a) => a.indexOf(f) === i);
  let tabs = 0, spaces2 = 0, spaces4 = 0, single = 0, dbl = 0, withSemi = 0, noSemi = 0, seen = 0;
  for (const rel of samples.slice(0, 5)) {
    if (!exists(root, rel)) continue;
    let text: string;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    seen++;
    for (const line of text.split('\n')) {
      if (/^\t/.test(line)) tabs++;
      else if (/^ {4}\S/.test(line)) spaces4++;
      else if (/^ {2}\S/.test(line)) spaces2++;
      single += (line.match(/'/g) ?? []).length;
      dbl += (line.match(/"/g) ?? []).length;
      if (/;\s*$/.test(line)) withSemi++;
      else if (/[)\w\]]\s*$/.test(line)) noSemi++;
    }
  }
  if (!seen) return null;
  const indent = tabs > spaces2 + spaces4 ? 'tabs' : spaces4 > spaces2 ? '4 spaces' : '2 spaces';
  return { indent, quotes: single >= dbl ? 'single' : 'double', semicolons: withSemi >= noSemi };
}

function walk(root: string): { langs: Map<string, number>; files: number; hasTests: boolean; hasSql: boolean } {
  const langs = new Map<string, number>();
  let files = 0;
  let hasTests = false;
  let hasSql = false;
  const stack: string[] = [root];
  let budget = 20000; // hard cap so huge repos still profile quickly
  while (stack.length && budget > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (budget-- <= 0) break;
      if (e.name.startsWith('.') && e.name !== '.env') {
        if (e.isDirectory()) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      if (lang) {
        langs.set(lang, (langs.get(lang) ?? 0) + 1);
        files++;
      }
      if (/\.(test|spec)\.[jt]sx?$/.test(e.name) || /_test\.(py|go)$/.test(e.name)) hasTests = true;
      if (ext === '.sql') hasSql = true;
    }
  }
  return { langs, files, hasTests, hasSql };
}

function topLevel(root: string): FolderNode[] {
  const out: FolderNode[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    let files = 0;
    let dirs = 0;
    try {
      for (const c of fs.readdirSync(path.join(root, e.name), { withFileTypes: true })) {
        if (c.isDirectory()) dirs++;
        else files++;
      }
    } catch {
      /* ignore unreadable dir */
    }
    out.push({ name: e.name, files, dirs });
  }
  return out.sort((a, b) => b.files + b.dirs - (a.files + a.dirs)).slice(0, 12);
}

function findArchDocs(root: string): { title: string; relPath: string }[] {
  const docs: { title: string; relPath: string }[] = [];
  const consider = (rel: string) => {
    const full = path.join(root, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) docs.push({ title: path.basename(rel), relPath: rel });
  };
  consider('README.md');
  consider('ARCHITECTURE.md');
  consider('CONTRIBUTING.md');
  const docsDir = path.join(root, 'docs');
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    try {
      for (const f of fs.readdirSync(docsDir)) {
        if (/\.mdx?$/i.test(f)) docs.push({ title: f, relPath: path.join('docs', f) });
      }
    } catch {
      /* ignore */
    }
  }
  return docs.slice(0, 12);
}

function detectPackageManager(root: string): string | null {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(root, 'package-lock.json')) || fs.existsSync(path.join(root, 'package.json'))) return 'npm';
  if (fs.existsSync(path.join(root, 'poetry.lock')) || fs.existsSync(path.join(root, 'pyproject.toml'))) return 'poetry';
  if (fs.existsSync(path.join(root, 'requirements.txt'))) return 'pip';
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'go modules';
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'cargo';
  return null;
}

function readPackageJson(root: string): { deps: Record<string, string>; devDeps: Record<string, string>; raw: Record<string, unknown> } | null {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { deps: pkg.dependencies ?? {}, devDeps: pkg.devDependencies ?? {}, raw: pkg };
  } catch {
    return null;
  }
}

/** Build a real profile of the folder from scratch. */
export function buildProfile(id: string, root: string): ProjectProfile {
  const { langs, files, hasTests, hasSql } = walk(root);
  const languages = [...langs.entries()].map(([name, n]) => ({ name, files: n })).sort((a, b) => b.files - a.files);
  const primaryLanguage = languages[0]?.name ?? 'unknown';

  const pkg = readPackageJson(root);
  const allDeps: { name: string; version: string; kind: 'runtime' | 'dev' }[] = [];
  const frameworks = new Set<string>();
  let hasDb = hasSql;
  if (pkg) {
    for (const [name, version] of Object.entries(pkg.deps)) {
      allDeps.push({ name, version: String(version), kind: 'runtime' });
      if (FRAMEWORK_DEPS[name]) frameworks.add(FRAMEWORK_DEPS[name]);
      if (DB_DEPS.has(name)) hasDb = true;
    }
    for (const [name, version] of Object.entries(pkg.devDeps)) {
      allDeps.push({ name, version: String(version), kind: 'dev' });
      if (FRAMEWORK_DEPS[name]) frameworks.add(FRAMEWORK_DEPS[name]);
    }
  }

  const structure = topLevel(root);
  const dirNames = new Set(structure.map((s) => s.name.toLowerCase()));
  const has = {
    frontend:
      frameworks.has('React') || frameworks.has('Vue') || frameworks.has('Next.js') || frameworks.has('Svelte') || frameworks.has('Angular') ||
      dirNames.has('src') && (langs.has('TypeScript') || langs.has('JavaScript')) || dirNames.has('components') || dirNames.has('pages') || dirNames.has('app'),
    backend:
      frameworks.has('Express') || frameworks.has('NestJS') || frameworks.has('Fastify') || frameworks.has('Django') || frameworks.has('Flask') || frameworks.has('FastAPI') ||
      dirNames.has('server') || dirNames.has('api') || dirNames.has('controllers') || dirNames.has('routes') || dirNames.has('services'),
    database: hasDb,
    config: fs.existsSync(path.join(root, '.env')) || fs.existsSync(path.join(root, '.env.example')) || dirNames.has('config'),
    git: fs.existsSync(path.join(root, '.git')),
    docker: fs.existsSync(path.join(root, 'Dockerfile')) || fs.existsSync(path.join(root, 'docker-compose.yml')) || fs.existsSync(path.join(root, 'docker-compose.yaml')),
    ci: fs.existsSync(path.join(root, '.github', 'workflows')) || fs.existsSync(path.join(root, '.gitlab-ci.yml')) || fs.existsSync(path.join(root, '.circleci')),
    tests: hasTests,
  };

  const type = classify(has, frameworks, languages.length);
  const summary = describe(root, primaryLanguage, type, [...frameworks], has, files);
  const pkgRaw = (pkg?.raw ?? {}) as { main?: string; module?: string; bin?: unknown; scripts?: Record<string, string>; description?: string };
  const entryPoints = deriveEntryPoints(root, pkg ? pkgRaw : null);

  return {
    id,
    path: root,
    generatedAt: new Date().toISOString(),
    fingerprint: fingerprint(root),
    type,
    primaryLanguage,
    languages,
    packageManager: detectPackageManager(root),
    frameworks: [...frameworks],
    dependencies: allDeps,
    has,
    structure,
    architectureDocs: findArchDocs(root),
    fileCount: files,
    summary,
    purpose: derivePurpose(root, pkgRaw.description),
    entryPoints,
    buildSystem: deriveBuildSystem(root),
    importantFiles: deriveImportantFiles(root, entryPoints),
    codingStyle: deriveCodingStyle(root, entryPoints),
  };
}

function classify(has: ProjectProfile['has'], frameworks: Set<string>, langCount: number): string {
  if (frameworks.has('Tauri') || frameworks.has('Electron')) return 'Desktop application';
  if (has.frontend && has.backend) return 'Full-stack application';
  if (has.frontend) return 'Frontend application';
  if (has.backend) return 'Backend service';
  if (langCount === 0) return 'Empty or non-code folder';
  return 'Library / tooling';
}

function describe(root: string, lang: string, type: string, frameworks: string[], has: ProjectProfile['has'], files: number): string {
  const parts: string[] = [];
  parts.push(`${path.basename(root)} is a ${type.toLowerCase()}${lang !== 'unknown' ? ` written primarily in ${lang}` : ''}.`);
  if (frameworks.length) parts.push(`It uses ${frameworks.slice(0, 6).join(', ')}.`);
  const surfaces = Object.entries(has).filter(([, v]) => v).map(([k]) => k);
  if (surfaces.length) parts.push(`Detected surfaces: ${surfaces.join(', ')}.`);
  parts.push(`${files} indexable source files found.`);
  return parts.join(' ');
}

/** Get the cached profile if the folder fingerprint is unchanged, else rebuild. */
export function getOrBuildProfile(id: string, root: string, force = false): ProjectProfile {
  const file = PROFILE_FILE(id);
  if (!force) {
    const cached = readJsonFile<ProjectProfile | null>(file, null);
    if (cached && cached.fingerprint === fingerprint(root)) return cached;
  }
  const profile = buildProfile(id, root);
  writeJsonFile(file, profile);
  return profile;
}

export function loadProfile(id: string): ProjectProfile | null {
  return readJsonFile<ProjectProfile | null>(PROFILE_FILE(id), null);
}

/**
 * Shared constants for the Repository Intelligence Engine.
 * ==================================================================
 * Single source of truth. Every module imports from here — no duplication.
 */

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.turbo', '.cache', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.aura',
  '.aura-index', '.aura-fullstack', '.idea', '.vscode',
]);

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.py': 'Python', '.rb': 'Ruby',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++', '.cs': 'C#', '.php': 'PHP',
  '.scala': 'Scala', '.ex': 'Elixir', '.exs': 'Elixir', '.dart': 'Dart',
  '.vue': 'Vue', '.svelte': 'Svelte', '.sql': 'SQL', '.sh': 'Shell',
  '.css': 'CSS', '.scss': 'CSS', '.html': 'HTML', '.md': 'Markdown',
  '.asm': 'Assembly', '.s': 'Assembly',
};

export const FRAMEWORK_DEPS: Record<string, string> = {
  react: 'React', 'react-dom': 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt',
  svelte: 'Svelte', '@angular/core': 'Angular', '@sveltejs/kit': 'SvelteKit',
  express: 'Express', '@nestjs/core': 'NestJS', '@nestjs/common': 'NestJS',
  '@nestjs/platform-express': 'NestJS', fastify: 'Fastify', koa: 'Koa',
  '@tauri-apps/api': 'Tauri', electron: 'Electron', vite: 'Vite', webpack: 'Webpack',
  tailwindcss: 'Tailwind CSS', typeorm: 'TypeORM', prisma: 'Prisma', sequelize: 'Sequelize',
  mongoose: 'Mongoose', django: 'Django', flask: 'Flask', fastapi: 'FastAPI',
  '@aura/core': 'AURA', zustand: 'Zustand', 'framer-motion': 'Framer Motion',
};

export const DB_DEPS = new Set([
  'pg', 'postgres', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongodb',
  'mongoose', 'redis', 'ioredis', 'typeorm', 'prisma', 'sequelize', 'drizzle-orm',
]);

export const estTokens = (s: string) => Math.ceil(s.length / 4);

/** Directory weight map for weighted language detection. */
export const DIR_WEIGHT: Record<string, number> = {
  kernel: 10, arch: 10, drivers: 10, mm: 10, fs: 10, net: 10, ipc: 10,
  boot: 10, init: 10, include: 8, lib: 8,
  src: 5, app: 5, packages: 5,
  scripts: 1, tools: 1, utils: 1,
  docs: 0, documentation: 0, examples: 0, test: 0, tests: 0, __tests__: 0,
};

/**
 * ESM hook: resolve @aura/* + extensionless imports, transpile TS.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveTs(base) {
  if (exists(base)) return base;
  for (const e of EXTS) if (exists(base + e)) return base + e;
  for (const i of INDEX) if (exists(path.join(base, i))) return path.join(base, i);
  return null;
}

function mapAura(specifier) {
  const parts = specifier.split('/'); // ['@aura', 'governance', ...]
  const name = parts[1];
  const sub = parts.slice(2).join('/');
  if (!name) return null;
  const pkgRoot = path.join(ROOT, 'packages', name);
  if (!fs.existsSync(pkgRoot)) return null;
  if (!sub) {
    // read package.json exports/main
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
      const target = pkg.exports?.['.'] ?? pkg.main;
      if (typeof target === 'string' && target.endsWith('.ts')) return path.join(pkgRoot, target);
    } catch {
      return null;
    }
    return null;
  }
  return resolveTs(path.join(pkgRoot, 'src', sub));
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@aura/')) {
    const target = mapAura(specifier);
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.endsWith('.ts') || parent.endsWith('.tsx')) {
      const base = path.resolve(path.dirname(parent), specifier);
      const target = resolveTs(base);
      if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  if ((file.endsWith('.ts') || file.endsWith('.tsx')) && !file.includes(`${path.sep}node_modules${path.sep}`)) {
    const source = fs.readFileSync(file, 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
      fileName: file,
    });
    return { format: 'module', source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}

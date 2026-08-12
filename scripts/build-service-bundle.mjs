/**
 * build-service-bundle — stage AURA's local service for packaging.
 * ==================================================================
 * The desktop shell starts `resources/ai-service.mjs` with a real Node
 * interpreter. Producing that file is *almost* the same esbuild call the
 * developer script uses, with one packaging-specific difference that is
 * worth stating plainly, because getting it wrong produces an application
 * that builds cleanly and then dies on launch.
 *
 * ## Why TypeScript is not bundled
 *
 * `packages/ai-service/src/diagnosis/*` imports the TypeScript compiler
 * API for AST analysis, so `typescript` is a genuine RUNTIME dependency.
 * It is marked `--external` because it cannot be bundled: TypeScript is
 * CommonJS and reaches for `require("fs")`, `__filename` and `__dirname`
 * at load time, none of which exist in an ESM bundle. Shimming those
 * globals does get past module load, but it leaves the compiler running
 * with faked CJS context in code paths this build cannot exercise — a
 * confident-looking build that might break somewhere inside diagnosis.
 *
 * So the real package is staged next to the bundle instead. Node resolves
 * a bare `typescript` import by walking up from the importing file, finds
 * `resources/node_modules/typescript`, and loads exactly the compiler the
 * development tree runs. Packaged and developed AURA execute the same
 * code, which is the only version of this worth shipping.
 *
 * Only `package.json` and `lib/typescript.js` are staged: the rest of the
 * published package is `.d.ts` declarations and a CLI, none of which are
 * loaded at runtime. That is ~9 MB instead of ~23 MB.
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO, 'apps/desktop/src-tauri/resources');
const TS_SRC = path.join(REPO, 'node_modules/typescript');
const TS_OUT = path.join(OUT_DIR, 'node_modules/typescript');

// Rebuilt from scratch every time: a stale file here would be shipped as
// if it were current, and a packaged backend silently older than its own
// source is exactly the kind of drift this repository avoids elsewhere.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(path.join(TS_OUT, 'lib'), { recursive: true });

/**
 * esbuild is called through its JavaScript API rather than through `npx`.
 *
 * This is a portability requirement, not a style choice. npm installs
 * `npx` as `npx.cmd` on Windows, and Node refuses to spawn a `.cmd`
 * without routing it through the command interpreter — so `execFileSync`
 * fails with ENOENT there and the packaging step dies before it starts.
 * The API call has no such problem on any platform, and it removes a
 * process spawn from the build besides.
 */
await build({
  entryPoints: [path.join(REPO, 'packages/ai-service/src/start.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['typescript'],
  outfile: path.join(OUT_DIR, 'ai-service.mjs'),
  absWorkingDir: REPO,
  logLevel: 'info',
});

for (const rel of ['package.json', 'lib/typescript.js']) {
  const from = path.join(TS_SRC, rel);
  if (!existsSync(from)) {
    throw new Error(
      `Cannot stage the TypeScript runtime: ${from} is missing. `
      + 'Run `npm install` before building the desktop application.',
    );
  }
  copyFileSync(from, path.join(TS_OUT, rel));
}

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`  ai-service.mjs        ${mb(path.join(OUT_DIR, 'ai-service.mjs'))} MB`);
console.log(`  typescript/lib        ${mb(path.join(TS_OUT, 'lib/typescript.js'))} MB`);
console.log(`  staged into           ${OUT_DIR}`);

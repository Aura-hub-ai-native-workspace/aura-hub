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
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO, 'apps/desktop/src-tauri/resources');
const TS_SRC = path.join(REPO, 'node_modules/typescript');
const TS_OUT = path.join(OUT_DIR, 'node_modules/typescript');

/*
 * The Python environment backend is staged under `resources/python/` in the
 * SAME shape it has in the repository: `scripts/` beside `backend/`. That
 * mirroring is load-bearing — `serve_central_agent_api.py` finds the `aura`
 * package with `Path(__file__).resolve().parents[1] / "backend"`, so a
 * staged copy that keeps its neighbour keeps working with no packaging
 * special case inside the Python.
 *
 * The third-party dependencies are staged beside it, under `site-packages/`
 * and `abi/cp3NN/`; see the vendoring block further down for why they are
 * split in two. What is still NOT staged is the interpreter itself, so
 * `service.rs` goes on discovering a Python on the machine — it just no
 * longer needs one that somebody has already installed Starlette into.
 *
 * `aura/` is pure Python plus one data file (`fabric/manifest.json`, found
 * relative to its own module), so the whole runtime set is ~1.8 MB of text.
 */
const PY_OUT = path.join(OUT_DIR, 'python');
const PY_ENTRY_REL = 'scripts/serve_central_agent_api.py';
const PY_PACKAGE_REL = 'backend/aura';

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

/**
 * Copy a directory of Python sources, skipping everything that is not part
 * of the runtime: `__pycache__` is regenerable, and shipping it would also
 * put bytecode compiled by the BUILD machine's interpreter next to source
 * the USER's interpreter is about to read.
 */
function stagePython(fromDir, toDir) {
  let files = 0;
  let bytes = 0;
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      const inner = stagePython(from, to);
      files += inner.files;
      bytes += inner.bytes;
      continue;
    }
    if (!entry.name.endsWith('.py') && !entry.name.endsWith('.json')) continue;
    copyFileSync(from, to);
    files += 1;
    bytes += statSync(to).size;
  }
  return { files, bytes };
}

const pyEntryFrom = path.join(REPO, PY_ENTRY_REL);
const pyPackageFrom = path.join(REPO, PY_PACKAGE_REL);
for (const required of [pyEntryFrom, pyPackageFrom]) {
  if (!existsSync(required)) {
    throw new Error(
      `Cannot stage the Python environment backend: ${required} is missing. `
      + 'A package without it builds cleanly and then reports no backend at runtime.',
    );
  }
}
mkdirSync(path.join(PY_OUT, 'scripts'), { recursive: true });
copyFileSync(pyEntryFrom, path.join(PY_OUT, PY_ENTRY_REL));
const staged = stagePython(pyPackageFrom, path.join(PY_OUT, PY_PACKAGE_REL));

/*
 * The backend's third-party dependencies, vendored.
 *
 * Until now AURA shipped its own source and then required the machine to
 * already have Starlette, uvicorn and Pydantic. On a clean install it does
 * not: a user on Arch had to `pacman -S python-starlette python-pydantic`
 * and `pip install uvicorn` by hand before the Machine Inventory would show
 * anything but "0 installed". Shipping source without its imports was never
 * a working product.
 *
 * Two directories, because the dependencies are not the same kind of thing:
 *
 *   site-packages/   pure Python (`py3-none-any`). One copy serves every
 *                    interpreter.
 *   abi/cp3NN/       `pydantic_core`, a compiled extension. Its wheel is
 *                    built per CPython version and is NOT abi3, so a cp312
 *                    build does not load into cp313 — it fails on an
 *                    `undefined symbol`, not a missing module. One directory
 *                    per supported version; the entry script picks the one
 *                    matching whoever is running.
 *
 * Per-platform needs no handling here: each CI runner stages wheels for its
 * own platform, so the macOS artifact carries macOS wheels and the Windows
 * one Windows wheels. Nothing cross-compiles.
 *
 * Still NOT vendored: an interpreter. AURA goes on using a Python from the
 * machine. This removes the requirement to have *configured* one.
 */
const PY_ABI_TAGS = ['cp312', 'cp313', 'cp314'];

/**
 * The backend's runtime requirements, read from the file that declares them.
 *
 * Deliberately not a list typed out here. `backend/pyproject.toml` caps
 * Starlette below 1.0 because the suite has never been run against 1.x, and
 * a second copy of that constraint is a second copy to forget: a bundle
 * resolved from a stale duplicate would ship versions the tests never
 * exercised, which is worse than shipping nothing.
 */
function backendRequirements() {
  const file = path.join(REPO, 'backend/pyproject.toml');
  const toml = readFileSync(file, 'utf8').replace(/^\s*#.*$/gm, '');
  const block = /^dependencies = \[([\s\S]*?)^\]/m.exec(toml);
  const reqs = block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (!reqs.length) {
    throw new Error(
      `Cannot read the backend's runtime dependencies from ${file}. `
      + 'Vendoring a guessed set would ship versions the test suite has '
      + 'never run against.',
    );
  }
  return reqs;
}

function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

/**
 * The interpreter that RESOLVES the wheels — not the one that runs them.
 *
 * Its pip picks the versions, so the choice is worth being explicit about;
 * `AURA_BUNDLE_PYTHON` exists for a build that needs to pin one. The
 * `python3` / `python` fallback is not cosmetic: Windows installs the
 * interpreter as `python`, and a build script that only knows `python3`
 * fails there with ENOENT after the rest of the packaging has succeeded.
 */
const stagingPython = (() => {
  const named = process.env.AURA_BUNDLE_PYTHON;
  const tried = named ? [named] : ['python3', 'python'];
  for (const exe of tried) {
    const probe = spawnSync(exe, ['-c', 'import pip'], { stdio: 'ignore' });
    if (probe.status === 0) return exe;
  }
  throw new Error(
    `No Python with pip was found (tried: ${tried.join(', ')}). `
    + 'The desktop package vendors the backend\'s dependencies at build '
    + 'time; set AURA_BUNDLE_PYTHON to an interpreter that has pip.',
  );
})();

const pip = (args) => execFileSync(stagingPython, ['-m', 'pip', ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const SITE_OUT = path.join(PY_OUT, 'site-packages');
const vendored = { bytes: 0, abis: [] };
try {
  pip(['install', '--quiet', '--no-compile', '--target', SITE_OUT,
    ...backendRequirements()]);

  // Console scripts: a `uvicorn` launcher hard-coded to the BUILD machine's
  // interpreter path. Nothing runs it, and shipping it would only invite
  // someone to try.
  rmSync(path.join(SITE_OUT, 'bin'), { recursive: true, force: true });
  rmSync(path.join(SITE_OUT, 'Scripts'), { recursive: true, force: true });

  /*
   * pydantic_core arrives here as a transitive dependency, built for the
   * STAGING interpreter. It is moved aside rather than kept, because one
   * version's binary sitting on the path for every interpreter is exactly
   * the crash the per-ABI directories exist to prevent.
   *
   * Its exact version is carried over to those directories: Pydantic pins
   * `pydantic-core==<x>` and checks the match at import, so re-resolving
   * the native half independently could pair two versions that refuse to
   * work together.
   */
  const coreDists = readdirSync(SITE_OUT)
    .filter((e) => e.startsWith('pydantic_core-') && e.endsWith('.dist-info'));
  if (coreDists.length !== 1) {
    throw new Error(
      `Expected exactly one vendored pydantic_core, found ${coreDists.length}.`,
    );
  }
  const coreVersion = coreDists[0].slice('pydantic_core-'.length, -'.dist-info'.length);
  for (const entry of readdirSync(SITE_OUT)) {
    if (entry.startsWith('pydantic_core')) {
      rmSync(path.join(SITE_OUT, entry), { recursive: true, force: true });
    }
  }

  for (const tag of PY_ABI_TAGS) {
    const abiOut = path.join(PY_OUT, 'abi', tag);
    try {
      pip(['install', '--quiet', '--no-compile', '--no-deps',
        '--only-binary=:all:', '--python-version', tag.slice('cp'.length),
        '--target', abiOut, `pydantic-core==${coreVersion}`]);
      vendored.abis.push(tag);
    } catch {
      // A CPython version with no published wheel for this platform is not
      // a build failure — that interpreter is simply unsupported here, and
      // the entry script finds no directory for it rather than loading a
      // binary built for someone else.
      rmSync(abiOut, { recursive: true, force: true });
    }
  }
  if (!vendored.abis.length) {
    throw new Error(
      `No pydantic-core==${coreVersion} wheel was available for any of `
      + `${PY_ABI_TAGS.join(', ')} on this platform.`,
    );
  }
  vendored.bytes = dirBytes(SITE_OUT) + dirBytes(path.join(PY_OUT, 'abi'));
} catch (e) {
  throw new Error(
    'Cannot vendor the Python backend dependencies: '
    + `${(e.stderr || e.message || '').toString().trim().slice(-400)}\n`
    + `Staging used "${stagingPython}"; set AURA_BUNDLE_PYTHON to pick another. `
    + 'Building without them produces an application that installs, launches, '
    + 'and then reports an empty machine.',
  );
}

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`  ai-service.mjs        ${mb(path.join(OUT_DIR, 'ai-service.mjs'))} MB`);
console.log(`  typescript/lib        ${mb(path.join(TS_OUT, 'lib/typescript.js'))} MB`);
console.log(
  `  python backend        ${(staged.bytes / 1024 / 1024).toFixed(1)} MB`
  + ` (${staged.files} files)`,
);
console.log(
  `  python deps           ${(vendored.bytes / 1024 / 1024).toFixed(1)} MB`
  + ` (pydantic_core for ${vendored.abis.join(', ')})`,
);
console.log(`  staged into           ${OUT_DIR}`);

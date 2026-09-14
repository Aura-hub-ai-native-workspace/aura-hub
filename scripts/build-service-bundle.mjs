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
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  lstatSync, rmSync, statSync, writeFileSync,
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

/*
 * The interpreter itself, bundled.
 *
 * Vendoring the dependencies removed the need for a CONFIGURED Python. It
 * did not remove the need for a Python, and that turns out to be most of
 * the problem: Windows ships none at all, macOS ships 3.9 through the
 * Command Line Tools, Ubuntu 22.04 ships 3.10 and Debian 12 ships 3.11 —
 * all below the 3.12 this backend requires. On those machines AURA still
 * installs and then reports an empty inventory, which is the exact failure
 * the dependency bundling was meant to end.
 *
 * So the runtime travels too. These are the `python-build-standalone`
 * distributions: ordinary CPython, built to be relocatable, which a normal
 * CPython installation is not — you cannot copy `/usr/bin/python3` into an
 * application and expect it to find its own standard library.
 *
 * Pinned by digest, not by name. The build downloads from a release URL,
 * and a URL is a promise about where bytes live, not about what they are;
 * the digest is checked before a single file is extracted, so a replaced
 * asset fails the build instead of shipping inside the application. The
 * digests below come from that release's own SHA256SUMS.
 *
 * Not vendored for platforms nobody builds on: each CI runner fetches the
 * distribution for its own target, so the table is keyed by what Node
 * reports about the machine doing the build.
 */
const PY_RUNTIME_RELEASE = '20260901';
const PY_RUNTIME_VERSION = '3.12.14';
const PY_RUNTIME_BUILDS = {
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu',
    sha256: '72748da13197c1fb161e3afeef20a6a385ff24f2165e6e2758e47008e7faba4c',
  },
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    sha256: '81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    sha256: '65b195c9cedc1fef6767f044f9822069adbd1bd9204d424ece4628776fdc04bb',
  },
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    sha256: '7c45c9622400d578709a9b2cddbe8124cc21d382409d9f13406d706d28e31b14',
  },
};

/** Where the bundled interpreter lives once staged, relative to PY_OUT. */
const PY_RUNTIME_EXE = process.platform === 'win32'
  ? 'runtime/python.exe'
  : 'runtime/bin/python3';

/**
 * Fetch, verify and unpack the interpreter for the platform being built.
 *
 * Returns the staged executable's path. Throws rather than falling back:
 * a build that quietly omits the runtime produces an application that is
 * broken on exactly the machines this exists to serve, and it would be
 * broken silently, on someone else's computer.
 */
async function stagePythonRuntime() {
  const key = `${process.platform}-${process.arch}`;
  const build = PY_RUNTIME_BUILDS[key];
  if (!build) {
    throw new Error(
      `No standalone CPython is pinned for ${key}. Add its triple and SHA-256 `
      + 'to PY_RUNTIME_BUILDS, or the application cannot ship a runtime for '
      + 'this platform.',
    );
  }
  const asset = `cpython-${PY_RUNTIME_VERSION}+${PY_RUNTIME_RELEASE}`
    + `-${build.triple}-install_only_stripped.tar.gz`;
  const url = 'https://github.com/astral-sh/python-build-standalone/releases'
    + `/download/${PY_RUNTIME_RELEASE}/${asset}`;

  // Cached across builds by digest. The name is the digest, so a cache hit
  // is a content match and never a stale file wearing the right name.
  const cacheDir = path.join(REPO, 'node_modules/.cache/aura-python-runtime');
  mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, `${build.sha256}.tar.gz`);

  if (!existsSync(cached)) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Could not download ${asset}: HTTP ${res.status} from ${url}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== build.sha256) {
      throw new Error(
        `${asset} does not match its pinned digest.\n  expected ${build.sha256}`
        + `\n  received ${got}\nRefusing to unpack it.`,
      );
    }
    writeFileSync(cached, bytes);
  } else {
    // Verify the cache too. A file on disk between builds is a file anything
    // on this machine could have edited.
    const got = createHash('sha256').update(readFileSync(cached)).digest('hex');
    if (got !== build.sha256) {
      rmSync(cached, { force: true });
      throw new Error(
        `The cached copy of ${asset} no longer matches its digest; it has been `
        + 'deleted. Re-run the build to download it again.',
      );
    }
  }

  // The archive unpacks to a single `python/` directory; stage that as
  // `runtime/` so the layout does not depend on the publisher's naming.
  const runtimeOut = path.join(PY_OUT, 'runtime');
  const tmp = path.join(PY_OUT, '.runtime-unpack');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  execFileSync('tar', ['-xzf', cached, '-C', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
  const unpacked = path.join(tmp, 'python');
  if (!existsSync(unpacked)) {
    throw new Error(`${asset} did not contain the expected python/ directory.`);
  }
  renameSync(unpacked, runtimeOut);
  rmSync(tmp, { recursive: true, force: true });

  const exe = path.join(PY_OUT, PY_RUNTIME_EXE);
  if (!existsSync(exe)) {
    throw new Error(`The staged runtime has no interpreter at ${PY_RUNTIME_EXE}.`);
  }
  // It has to actually run on this machine before anything is built around
  // it — a runtime that unpacks and then cannot execute is worse than none.
  const reported = execFileSync(exe, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
    { encoding: 'utf8' }).trim();
  if (reported !== PY_RUNTIME_VERSION) {
    throw new Error(
      `The staged interpreter reports ${reported}, not the pinned ${PY_RUNTIME_VERSION}.`,
    );
  }
  return exe;
}


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

/**
 * Bytes on disk under `dir`.
 *
 * Uses `lstat`, so a symlink counts as the link and not as a second copy
 * of its target — a runtime tree is full of them (`python3` → `python3.12`)
 * and following them would report an interpreter twice its real size. It
 * also means a dangling link is measured rather than throwing, which a
 * trimming step makes an ordinary thing to encounter.
 */
function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { total += dirBytes(p); continue; }
    try { total += lstatSync(p).size; } catch { /* vanished mid-walk */ }
  }
  return total;
}

/*
 * The dependencies are resolved BY the interpreter that will run them.
 *
 * This used to hunt for any `python3` on the build machine, which made the
 * shipped `pydantic_core` a property of whichever CI image was current.
 * Now that the runtime travels with the application there is exactly one
 * right answer, and using it removes a whole class of mismatch: the wheel
 * is built for this CPython because this CPython asked for it.
 */
const stagingPython = await stagePythonRuntime();
if (spawnSync(stagingPython, ['-c', 'import pip'], { stdio: 'ignore' }).status !== 0) {
  throw new Error(
    `The bundled interpreter at ${stagingPython} has no pip, so the backend's `
    + 'dependencies cannot be vendored.',
  );
}

const pip = (args) => execFileSync(stagingPython, ['-m', 'pip', ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

/**
 * Remove what a backend never reaches for.
 *
 * The distribution is built to be a general-purpose Python installation:
 * it can compile extensions, open a Tk window and run IDLE. AURA does none
 * of that — it imports Starlette and reads the machine — so roughly half
 * of what arrives is weight the user downloads and never executes.
 *
 * Each entry is here because something specific made it unnecessary, and
 * the list is deliberately short. Trimming a standard library is how you
 * ship an interpreter that works until the one day it needs `ssl`, so
 * nothing is removed on a hunch: the runtime is exercised after this runs
 * (`--check` imports the whole backend), and packaging-verify starts the
 * real thing on a machine with no other Python.
 */
/**
 * Everything to delete from the staged interpreter, for this platform.
 *
 * The three distributions are laid out differently — Unix puts the
 * standard library under `lib/python3.12/`, Windows uses `Lib/` beside
 * `DLLs/` and a top-level `tcl/` — so the list is computed, not written
 * once and hoped over. Entries are matched by prefix wherever a name
 * carries a version that could move under us.
 */
function runtimeDropList(runtimeDir) {
  const under = (dir, pred) => {
    const full = path.join(runtimeDir, dir);
    if (!existsSync(full)) return [];
    return readdirSync(full).filter(pred).map((n) => path.join(dir, n));
  };

  if (process.platform === 'win32') {
    return [
      // Tk: no GUI in a headless API server, and the largest thing here.
      'tcl', 'Lib/tkinter', 'Lib/idlelib', 'Lib/turtledemo',
      ...under('DLLs', (n) => n.startsWith('_tkinter') || n.startsWith('tcl') || n.startsWith('tk')),
      // For BUILDING extensions. The wheels are already built.
      'include', 'libs',
      // pip vendored the dependencies moments ago and is now expendable —
      // and a package manager inside a signed artifact invites use.
      'Lib/site-packages/pip', 'Lib/ensurepip',
    ];
  }

  const lib = 'lib';
  const stdlib = 'lib/python3.12';
  return [
    // The shared library and every symlink to it. `bin/python3.12` is
    // statically linked on both Linux and macOS, and no extension module
    // references it — verified on each distribution, not assumed. Matched
    // by prefix so a dangling `libpython3.12.so -> …so.1.0` cannot be left.
    ...under(lib, (n) => n.startsWith('libpython')),
    // Tk, by prefix: the Tcl/Tk version is part of these names and moves
    // between distributions.
    ...under(lib, (n) => /^(libtcl|libtk|tcl|tk)/.test(n)),
    `${stdlib}/tkinter`, `${stdlib}/idlelib`, `${stdlib}/turtledemo`,
    // Extension modules belonging to the same decisions. Leaving one while
    // deleting the libraries it links against produces an ELF with an
    // unresolvable dependency, and `linuxdeploy` walks every ELF in the
    // AppDir and fails the whole build on one — the trim would break
    // packaging rather than the feature it meant to drop.
    //
    // `_crypt` goes for its own reason: deprecated since 3.11, gone in
    // 3.13, unused here, and it links the `libcrypt.so.1` that modern
    // distributions replaced with libxcrypt.
    ...under(`${stdlib}/lib-dynload`, (n) => n.startsWith('_tkinter') || n.startsWith('_crypt')),
    // Headers and the static library: for BUILDING extensions.
    'include', ...under(stdlib, (n) => n.startsWith('config-')),
    // See the Windows note on pip.
    `${stdlib}/site-packages/pip`, `${stdlib}/ensurepip`,
    // A terminal capability database and man pages, for a process with no
    // terminal and no reader.
    'share/terminfo', 'share/man',
  ];
}

function trimPythonRuntime(runtimeDir) {
  const before = dirBytes(runtimeDir);
  for (const rel of runtimeDropList(runtimeDir)) {
    rmSync(path.join(runtimeDir, rel), { recursive: true, force: true });
  }
  // Bytecode compiled by the build machine, next to source the user's copy
  // will read. Regenerable, and `PYTHONDONTWRITEBYTECODE` means it never is.
  const sweepCaches = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === '__pycache__') rmSync(full, { recursive: true, force: true });
      else sweepCaches(full);
    }
  };
  sweepCaches(runtimeDir);

  /*
   * Nothing in the runtime may reference a library that is not there.
   *
   * This is the trim policing itself. `linuxdeploy` resolves every ELF in
   * the AppDir and fails the whole build on one unresolved dependency, so
   * an over-eager deletion here surfaces as an opaque packaging error
   * minutes later and on a different machine. Checking it at the point of
   * deletion turns that into a sentence naming the file.
   */
  if (process.platform === 'linux') {
    const unresolved = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile() || !/\.so(\.|$)/.test(entry.name)) continue;
        const out = spawnSync('ldd', [full], { encoding: 'utf8' }).stdout ?? '';
        const missing = [...out.matchAll(/^\s*(\S+) => not found/gm)].map((m) => m[1]);
        if (missing.length) {
          unresolved.push(`${path.relative(runtimeDir, full)} needs ${missing.join(', ')}`);
        }
      }
    };
    walk(runtimeDir);
    if (unresolved.length) {
      throw new Error(
        'Trimming the bundled interpreter left modules with unresolvable '
        + `libraries:\n  ${unresolved.join('\n  ')}\n`
        + 'Remove those modules alongside the libraries they need, or keep '
        + 'the libraries.',
      );
    }
  }
  /*
   * And it must still be an interpreter afterwards.
   *
   * The `ldd` sweep above is Linux-only and catches a specific kind of
   * damage; this catches the rest, on every platform, by the only test
   * that really settles it — importing the backend through the trimmed
   * runtime. Cheap, and it runs before anything is built around the
   * result.
   */
  const exe = path.join(PY_OUT, PY_RUNTIME_EXE);
  const alive = spawnSync(exe, ['-c', 'import ssl, hashlib, sqlite3, asyncio, ctypes'],
    { encoding: 'utf8' });
  if (alive.status !== 0) {
    throw new Error(
      'Trimming the bundled interpreter broke it: '
      + `${(alive.stderr || '').trim().split('\n').pop()}`,
    );
  }
  return { before, after: dirBytes(runtimeDir) };
}

const SITE_OUT = path.join(PY_OUT, 'site-packages');
const vendored = { bytes: 0, abis: [] };
let trimmed = { before: 0, after: 0 };
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
  // Only now that the wheels are resolved is pip expendable.
  trimmed = trimPythonRuntime(path.join(PY_OUT, 'runtime'));
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
  `  python runtime        ${(trimmed.after / 1024 / 1024).toFixed(1)} MB`
  + ` (CPython ${PY_RUNTIME_VERSION}, ${process.platform}-${process.arch};`
  + ` trimmed from ${(trimmed.before / 1024 / 1024).toFixed(1)} MB)`,
);
console.log(
  `  python deps           ${(vendored.bytes / 1024 / 1024).toFixed(1)} MB`
  + ` (pydantic_core for ${vendored.abis.join(', ')})`,
);
console.log(`  staged into           ${OUT_DIR}`);

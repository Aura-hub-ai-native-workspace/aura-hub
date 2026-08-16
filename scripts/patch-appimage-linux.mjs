/**
 * patch-appimage-linux — remove the bundled libwayland-client from the AppImage.
 * ==================================================================
 * The AppImage Tauri produces on the Ubuntu 24.04 runner bundles
 * `libwayland-client.so.0` from that distribution. The bundled copy
 * predates `wl_fixes_interface` and `wl_display_create_queue_with_name`,
 * which the distribution's own newer Mesa (26.x) requires — so at runtime
 * the AppRun path-seeding resolves those symbols against the OLD bundled
 * library while loading the system's `libEGL_mesa.so.0`. The mismatch
 * aborts the WebKitWebProcess with
 *
 *     Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
 *
 * and the window stays white. This is a packaging defect, not a code one:
 * the `.deb` (system webkit/GTK, no bundled Wayland) renders correctly on
 * the same machine, and so does the AppImage once the bundled library is
 * removed. Removing that one library leaves the system's own
 * `libwayland-client` (which exports the required symbols) to be resolved
 * in its place.
 *
 * This script repairs the AppImage IN PLACE after `tauri build` and before
 * staging, so every later step — staging, installer verification, release —
 * exercises the fixed artifact. It is Linux-only by construction; Windows
 * and macOS ship no AppImage.
 *
 * The repack uses `linuxdeploy-plugin-appimage.AppImage`, which Tauri
 * itself downloads into `~/.cache/tauri/` during the build (it is the
 * appimagetool wrapper used to create the original). Override with
 * `APPIMAGETOOL` if it lives elsewhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPIMAGE_DIR = path.join(ROOT, 'apps/desktop/src-tauri/target/release/bundle/appimage');
const EXCLUDED = path.join('usr', 'lib', 'libwayland-client.so.0');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${r.status}`);
  }
}

function findTool() {
  const candidates = [
    process.env.APPIMAGETOOL,
    path.join(os.homedir(), '.cache', 'tauri', 'linuxdeploy-plugin-appimage.AppImage'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of ['appimagetool', 'linuxdeploy-plugin-appimage.AppImage']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const appimages = fs.existsSync(APPIMAGE_DIR)
  ? fs.readdirSync(APPIMAGE_DIR).filter((f) => f.endsWith('.AppImage')).sort()
  : [];
if (appimages.length === 0) {
  console.error(`patch-appimage-linux: no AppImage found under ${APPIMAGE_DIR}.`);
  console.error('The Linux bundle declares "appimage" — if the build stopped producing one, this step must fail loudly, not pass quietly.');
  process.exit(1);
}

const tool = findTool();
if (!tool) {
  console.error('patch-appimage-linux: no repack tool found.');
  console.error('Tauri downloads linuxdeploy-plugin-appimage.AppImage into ~/.cache/tauri/ during `tauri build` — run the build first, or point APPIMAGETOOL at an appimagetool binary.');
  process.exit(1);
}

/**
 * Re-sign a patched AppImage, so the signature covers the bytes that ship.
 *
 * Tauri CLI 2.11.x with `bundle.createUpdaterArtifacts: true` signs the
 * NATIVE BUNDLE IN PLACE: on Linux the updater artifact IS the AppImage,
 * with a detached `AURA Hub_<v>_amd64.AppImage.sig` beside it. There is
 * no `.AppImage.tar.gz` — that wrapper belongs to the `"v1Compatible"`
 * mode, which this project does not use.
 *
 * That makes the ordering load-bearing. `tauri build` signs, and THEN
 * this script rewrites the AppImage. Left alone, the signature on disk
 * would cover the pre-patch bytes — the exact white-window build this
 * script exists to remove — while the file beside it is the patched one.
 * Published that way, every Linux client downloads the patched AppImage,
 * fails minisign verification against the stale signature, and reports
 * INVALID_SIGNATURE: the one failure AURA never retries, because it reads
 * as tampering. The pipeline would have manufactured a tamper warning.
 *
 * So the sequence is BUILD → PATCH → SIGN → STAGE, and this function is
 * the third step. It runs on the final bytes, and nothing rewrites the
 * AppImage after it.
 *
 * The stale signature is REMOVED BEFORE signing rather than overwritten.
 * If signing then fails, the build is left with no signature at all and
 * staging refuses on the missing `.sig` — which is loud. Overwriting in
 * place would leave the old signature behind on failure, which is not.
 *
 * The `.deb` is never touched here: it needs no patch (it bundles no
 * Wayland library), its signature still covers its own unmodified bytes,
 * and it is excluded from the updater set at staging regardless.
 */
function resignPatchedAppImage(appimage) {
  const sig = `${appimage}.sig`;
  const hadSig = fs.existsSync(sig);

  const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  if (!key && !keyPath) {
    if (hadSig) {
      fs.rmSync(sig);
      console.error(`patch-appimage-linux: ${path.basename(sig)} signs the PRE-PATCH AppImage and no signing key is available to replace it.`);
      console.error('The stale signature has been removed rather than left to be published. Set TAURI_SIGNING_PRIVATE_KEY and re-run.');
      process.exit(1);
    }
    // An unsigned build (`--no-sign`): there was no signature to keep in
    // step, and this is not a build anything will publish. Staging refuses
    // it on the missing signature if anyone tries.
    console.log('patch-appimage-linux: no signing key set and the build was unsigned — AppImage patched, still unsigned.');
    return;
  }

  if (hadSig) fs.rmSync(sig);

  // The Tauri CLI reads the key from the environment; it is never passed
  // as an argument, so it cannot land in a process listing or a CI log.
  run('npx', ['tauri', 'signer', 'sign', appimage], { cwd: ROOT });
  if (!fs.existsSync(sig)) {
    throw new Error(`signing reported success but produced no ${path.basename(sig)}`);
  }
  console.log(`patch-appimage-linux: re-signed ${path.basename(appimage)} — the signature now covers the patched bytes.`);
}

let patched = 0;
for (const name of appimages) {
  const appimage = path.join(APPIMAGE_DIR, name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-appimage-'));
  try {
    run(appimage, ['--appimage-extract'], { cwd: tmp });
    const squash = path.join(tmp, 'squashfs-root');
    const lib = path.join(squash, ...EXCLUDED.split(path.sep));
    if (!fs.existsSync(lib)) {
      // Nothing was rewritten, so the signature `tauri build` produced
      // still covers these exact bytes. Re-signing would be busywork.
      console.log(`patch-appimage-linux: ${name} — no bundled ${EXCLUDED}; already clean, nothing to do.`);
      continue;
    }
    fs.rmSync(lib);

    run(tool, ['--appimage-extract-and-run', '--appdir', squash], {
      cwd: tmp,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
    });
    const repacked = fs.readdirSync(tmp).find((f) => f.endsWith('.AppImage'));
    if (!repacked) throw new Error('repack produced no AppImage — tool failed silently');

    const verifyDir = path.join(tmp, 'verify');
    fs.mkdirSync(verifyDir);
    run(path.join(tmp, repacked), ['--appimage-extract'], { cwd: verifyDir });
    if (fs.existsSync(path.join(verifyDir, 'squashfs-root', ...EXCLUDED.split(path.sep)))) {
      throw new Error(`verification failed: ${EXCLUDED} is still present in the repacked AppImage`);
    }

    const repackedPath = path.join(tmp, repacked);
    fs.copyFileSync(repackedPath, appimage);
    fs.chmodSync(appimage, 0o755);
    const mb = (fs.statSync(appimage).size / 1024 / 1024).toFixed(1);
    console.log(`patch-appimage-linux: ${name} — ${EXCLUDED} removed, repacked in place (${mb} MB), verified clean.`);
    patched++;

    // The bytes on disk have just changed. The signature beside them was
    // made by `tauri build` over the bytes that were there before, and
    // this is the same file the updater downloads — so it must be signed
    // again, here, before anything stages or publishes it.
    resignPatchedAppImage(appimage);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`patch-appimage-linux: ${patched}/${appimages.length} AppImage(s) patched.`);
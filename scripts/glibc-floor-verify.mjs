/**
 * glibc-floor-verify — the oldest glibc the shipped Linux binaries can load on.
 * ==============================================================================
 * An artifact built on a rolling distribution links against whatever glibc that
 * machine has, and the symbols it actually uses decide the oldest system it can
 * run on. Nothing else in the release gates looks at this, so a build host
 * upgrade could silently drop Ubuntu 22.04 / Debian 12 users.
 *
 * Reads the dynamic symbol table of every ELF file under the given paths and
 * reports the highest NON-WEAK `GLIBC_x.y` version requirement (a version need
 * flagged WEAK, as Rust's std emits for `pidfd_spawnp`, does not stop the loader
 * from running on an older glibc). It is static analysis: it says nothing about
 * libwebkit2gtk / GTK availability or about actually running on that distro.
 *
 * Usage: node scripts/glibc-floor-verify.mjs [--max 2.34] <file-or-dir>...
 * Exit 0 = every file is at or below --max, 1 = a file exceeds it, 2 = no ELF
 * files found or readelf missing (not a pass).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--max');
const MAX = mi >= 0 ? argv.splice(mi, 2)[1] : '2.34';
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; };

function* walk(p) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) { for (const n of fs.readdirSync(p)) yield* walk(path.join(p, n)); return; }
  if (st.isFile() && st.size > 4096) yield p;
}
const isElf = (f) => { try { const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('latin1') === '\x7fELF'; } catch { return false; } };

function floorOf(file) {
  const out = execFileSync('readelf', ['-V', '-W', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  let max = null;
  for (const m of out.matchAll(/Name: GLIBC_([0-9.]+)\s+Flags: (\w+)/g)) {
    if (m[2] === 'WEAK') continue;
    if (max === null || cmp(m[1], max) > 0) max = m[1];
  }
  return max;
}

let seen = 0; let bad = 0;
try { execFileSync('readelf', ['--version'], { stdio: 'ignore' }); } catch { console.error('BLOCKED: readelf is not installed'); process.exit(2); }
for (const root of argv) {
  for (const f of walk(path.resolve(root))) {
    if (!isElf(f)) continue;
    let floor; try { floor = floorOf(f); } catch { continue; }
    seen += 1;
    if (floor && cmp(floor, MAX) > 0) { bad += 1; console.log(`FAIL  glibc ${floor} > ${MAX}  ${f}`); }
  }
}
if (!seen) { console.error('BLOCKED: no ELF files found'); process.exit(2); }
console.log(`${bad ? 'FAIL' : 'PASS'}  ${seen} ELF files checked, ${bad} above glibc ${MAX} (static analysis only)`);
process.exit(bad ? 1 : 0);

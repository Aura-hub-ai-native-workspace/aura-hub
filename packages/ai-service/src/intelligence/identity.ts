/**
 * Project Identity Engine
 * ==================================================================
 * Repository Identity is AURA's single source of truth — every field
 * here becomes an authoritative fact in the prompt. So identity must be
 * derived from REAL, WEIGHTED repository evidence, never from language
 * alone and never from the first folders encountered.
 *
 * One deep scan of the tree gathers directory names (at every depth),
 * a bounded sample of source files, build markers and language weights.
 * Each field (type, architecture, platform, entry points, modules,
 * purpose) is then decided from that combined evidence.
 *
 * Stored at ~/.aura/identity/<projectId>.json; regenerated only when the
 * project fingerprint changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homePath, readJsonFile, writeJsonFile } from '../persist';
import { IGNORE_DIRS, LANG_BY_EXT, DIR_WEIGHT } from './constants';
import type { ProjectIdentity, RepositoryType, Platform, ArchitectureStyle } from './types';

const IDENTITY_FILE = (id: string) => homePath('identity', `${id}.json`);

/* ── Deep repository scan (one pass, bounded) ─────────────────────── */

interface RepoScan {
  /** Every directory basename at any depth, lowercased. */
  dirNames: Set<string>;
  /** Tokens from directory names split on separators (x86_64 → x86, 64). */
  dirTokens: Set<string>;
  /** Relative directory paths, lowercased (arch/x86_64 stays intact). */
  dirRelPaths: string[];
  /** Immediate child directories of the root, original case. */
  topLevelDirs: string[];
  /** Weighted language counts. */
  langCounts: Map<string, number>;
  /** Source files worth reading for entry-point / signal analysis. */
  candidates: { rel: string; abs: string; ext: string }[];
  /** File-extension presence, lowercased. */
  exts: Set<string>;
}

const CANDIDATE_EXTS = new Set(['.c', '.cc', '.cpp', '.h', '.rs', '.py', '.go', '.ts', '.tsx', '.js', '.jsx', '.s', '.asm', '.ld']);

function isEntryDir(name: string): boolean {
  return ['boot', 'kernel', 'arch', 'src', 'cmd', 'init', 'app'].includes(name);
}
function looksLikeEntryFile(base: string): boolean {
  return /^(main|index|kmain|kernel|boot|start|_start|entry|app|linker|link)\b/i.test(base) || /\.(ld|s|asm)$/i.test(base);
}

function scanRepository(root: string): RepoScan {
  const dirNames = new Set<string>();
  const dirTokens = new Set<string>();
  const dirRelPaths: string[] = [];
  const langCounts = new Map<string, number>();
  const candidates: { rel: string; abs: string; ext: string }[] = [];
  const exts = new Set<string>();

  let topLevelDirs: string[] = [];
  try {
    topLevelDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch { /* ignore */ }

  let budget = 40000;
  const stack: string[] = [root];
  while (stack.length && budget > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (budget-- <= 0) break;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const lower = e.name.toLowerCase();
        dirNames.add(lower);
        for (const t of lower.split(/[-_.]+/)) if (t) dirTokens.add(t);
        dirRelPaths.push(path.relative(root, full).toLowerCase().split(path.sep).join('/'));
        stack.push(full);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      const lang = LANG_BY_EXT[ext];
      if (lang) {
        const rel = path.relative(root, path.join(dir, e.name));
        langCounts.set(lang, (langCounts.get(lang) ?? 0) + dirWeight(rel));
      }
      if (ext) exts.add(ext);
      if (CANDIDATE_EXTS.has(ext) && candidates.length < 160) {
        const base = e.name.toLowerCase();
        const parent = path.basename(dir).toLowerCase();
        if (dir === root || isEntryDir(parent) || looksLikeEntryFile(base) || ext === '.ld' || ext === '.s' || ext === '.asm') {
          candidates.push({ rel: path.relative(root, path.join(dir, e.name)), abs: path.join(dir, e.name), ext });
        }
      }
    }
  }
  return { dirNames, dirTokens, dirRelPaths, topLevelDirs, langCounts, candidates, exts };
}

function dirWeight(relPath: string): number {
  const parts = relPath.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    const w = DIR_WEIGHT[parts[i]];
    if (w !== undefined) return w;
  }
  return 3;
}

function readHead(abs: string, bytes = 8192): string {
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch { return ''; }
}

/* ── Low-level repository signals (read once, reused everywhere) ──── */

interface RepoSignals {
  hasLinkerScript: boolean;
  hasBootAsm: boolean;
  hasFreestanding: boolean;   // -ffreestanding / -nostdlib in the build
  hasKernelEntry: boolean;    // kmain / _start / multiboot in sources
  hasUefi: boolean;
  hasGrammar: boolean;        // .y / .l / .g4 → compiler
  buildText: string;          // concatenated build-file heads (lowercased)
  archTokens: Set<string>;    // x86_64, arm64, riscv … from paths + build
}

function collectSignals(root: string, scan: RepoScan): RepoSignals {
  const buildFiles = ['Makefile', 'makefile', 'CMakeLists.txt', 'Cargo.toml', 'Kbuild', 'meson.build'];
  let buildText = '';
  for (const f of buildFiles) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) buildText += '\n' + readHead(abs, 4096).toLowerCase();
  }

  const archTokens = new Set<string>();
  const pathHay = scan.dirRelPaths.join(' ') + ' ' + [...scan.dirTokens].join(' ') + ' ' + buildText;
  if (/\b(x86[_-]?64|amd64|x64)\b/.test(pathHay)) archTokens.add('x86_64');
  if (/\b(i386|ia32|i686)\b/.test(pathHay) || (/\bx86\b/.test(pathHay) && !archTokens.has('x86_64'))) archTokens.add('x86');
  if (/\b(aarch64|arm64)\b/.test(pathHay)) archTokens.add('arm64');
  if (/\barm(v\d)?\b/.test(pathHay)) archTokens.add('arm');
  if (/\b(riscv|risc-v|rv64|rv32)\b/.test(pathHay)) archTokens.add('riscv');

  let hasLinkerScript = false, hasBootAsm = false, hasKernelEntry = false, hasUefi = false;
  const hasGrammar = [...scan.exts].some((e) => ['.y', '.l', '.g4', '.ebnf'].includes(e));

  if (/-ffreestanding|-nostdlib|-nostdinc|-mno-red-zone|-mcmodel=kernel/.test(buildText)) { /* set below */ }
  const hasFreestanding = /-ffreestanding|-nostdlib|-nostdinc|-mno-red-zone|-mcmodel=kernel/.test(buildText);
  if (/efi|uefi|gnu-efi/.test(buildText)) hasUefi = true;

  // Read a bounded set of candidate files for real entry / kernel signals.
  let read = 0;
  for (const c of scan.candidates) {
    if (c.ext === '.ld') hasLinkerScript = true;
    if ((c.ext === '.s' || c.ext === '.asm') && read < 60) {
      const t = readHead(c.abs, 4096);
      if (/\b_start\b|multiboot|\.global\s+_start|global\s+_start/i.test(t)) hasBootAsm = true;
      read++;
      continue;
    }
    if (read >= 60) continue;
    if (['.c', '.cc', '.cpp', '.h', '.rs'].includes(c.ext)) {
      const t = readHead(c.abs, 6144);
      read++;
      if (/\bkmain\s*\(|\b_start\b|multiboot|kernel_main\s*\(/i.test(t)) hasKernelEntry = true;
      if (/\befi_main\b|\bEfiMain\b|EFI_SYSTEM_TABLE/.test(t)) hasUefi = true;
    }
  }
  if (scan.candidates.some((c) => c.ext === '.ld')) hasLinkerScript = true;

  return { hasLinkerScript, hasBootAsm, hasFreestanding, hasKernelEntry, hasUefi, hasGrammar, buildText, archTokens };
}

/* ── Repository type — weighted evidence ─────────────────────────── */

const TYPE_DIR_PATTERNS: Record<Exclude<RepositoryType, 'unknown'>, { dirs: string[]; weight: number }> = {
  'operating-system': { dirs: ['boot', 'kernel', 'arch', 'mm', 'drivers', 'fs', 'init', 'sched', 'scheduler', 'ipc', 'syscall', 'interrupt', 'irq', 'acpi'], weight: 4 },
  kernel: { dirs: ['kernel', 'arch', 'mm', 'drivers', 'fs', 'sched', 'scheduler', 'ipc', 'irq', 'interrupt', 'syscall'], weight: 4 },
  compiler: { dirs: ['parser', 'lexer', 'codegen', 'ast', 'ir', 'optimizer', 'sema', 'frontend', 'backend', 'typecheck'], weight: 4 },
  database: { dirs: ['storage', 'query', 'planner', 'executor', 'catalog', 'transaction', 'wal', 'btree', 'buffer'], weight: 4 },
  infrastructure: { dirs: ['terraform', 'helm', 'charts', 'ansible', 'k8s', 'kubernetes', 'manifests'], weight: 5 },
  'ai-framework': { dirs: ['training', 'inference', 'models', 'transformer', 'attention', 'tokenizer', 'dataset', 'layers', 'optim'], weight: 4 },
  cli: { dirs: ['commands', 'cmd', 'cli', 'subcommands'], weight: 3 },
  library: { dirs: ['lib', 'src', 'include'], weight: 1 },
  frontend: { dirs: ['components', 'pages', 'hooks', 'styles', 'assets', 'views'], weight: 3 },
  backend: { dirs: ['server', 'api', 'controllers', 'routes', 'services', 'middleware', 'handlers'], weight: 3 },
  fullstack: { dirs: ['components', 'pages', 'server', 'api', 'controllers', 'routes'], weight: 2 },
  mobile: { dirs: ['android', 'ios', 'screens', 'navigation'], weight: 4 },
  desktop: { dirs: ['src-tauri', 'src-electron'], weight: 5 },
  game: { dirs: ['sprites', 'scenes', 'entities', 'systems', 'ecs'], weight: 4 },
  embedded: { dirs: ['firmware', 'hal', 'bsp'], weight: 4 },
};

const WEB_FRONTEND = ['React', 'Vue', 'Next.js', 'Nuxt', 'SvelteKit', 'Svelte', 'Angular'];
const WEB_BACKEND = ['Express', 'NestJS', 'Fastify', 'Koa', 'Django', 'Flask', 'FastAPI'];

function detectRepositoryType(scan: RepoScan, sig: RepoSignals, frameworks: string[], primary: string): RepositoryType {
  const present = (dir: string) => scan.dirNames.has(dir) || scan.dirTokens.has(dir);

  const scores = new Map<RepositoryType, number>();
  for (const [type, pat] of Object.entries(TYPE_DIR_PATTERNS) as [RepositoryType, { dirs: string[]; weight: number }][]) {
    let hits = 0;
    for (const d of pat.dirs) if (present(d)) hits++;
    if (hits) scores.set(type, hits * pat.weight);
  }

  // File-level evidence — the decisive signals a folder scan alone misses.
  const bump = (t: RepositoryType, n: number) => scores.set(t, (scores.get(t) ?? 0) + n);
  const nativeLang = primary === 'C' || primary === 'C++' || primary === 'Rust' || primary === 'Assembly';
  if (sig.hasLinkerScript) { bump('operating-system', 5); bump('kernel', 5); bump('embedded', 3); }
  if (sig.hasBootAsm) { bump('operating-system', 6); bump('kernel', 6); }
  if (sig.hasKernelEntry) { bump('operating-system', 7); bump('kernel', 7); }
  if (sig.hasFreestanding) { bump('operating-system', 5); bump('kernel', 5); bump('embedded', 3); }
  if (sig.hasUefi) { bump('operating-system', 3); bump('kernel', 2); }
  if (sig.hasGrammar) bump('compiler', 5);

  // Strong kernel/OS evidence wins outright — build system never overrides it.
  const kernelScore = Math.max(scores.get('operating-system') ?? 0, scores.get('kernel') ?? 0);
  const strongKernel = sig.hasKernelEntry || sig.hasBootAsm || (sig.hasLinkerScript && nativeLang) || (present('boot') && (present('kernel') || present('arch'))) || kernelScore >= 12;
  if (strongKernel && nativeLang) {
    return (present('boot') || present('arch') || present('init')) ? 'operating-system' : 'kernel';
  }

  // Web-framework evidence is decisive for JS/TS ecosystems.
  const hasFrontend = frameworks.some((f) => WEB_FRONTEND.includes(f));
  const hasBackend = frameworks.some((f) => WEB_BACKEND.includes(f));
  if (hasFrontend && hasBackend) return 'fullstack';
  if (hasFrontend) return 'frontend';
  if (hasBackend) return 'backend';
  if (frameworks.some((f) => f === 'Tauri' || f === 'Electron')) return 'desktop';

  // Otherwise the best-scoring evidence pattern.
  let best: RepositoryType = 'unknown';
  let bestScore = 0;
  for (const [type, score] of scores) if (score > bestScore) { bestScore = score; best = type; }
  if (bestScore > 0) return best;

  // Last-resort language heuristic.
  if (nativeLang && (present('kernel') || present('arch') || present('drivers'))) return 'kernel';
  if (present('src') || present('lib')) return 'library';
  return 'unknown';
}

/* ── Architecture style ──────────────────────────────────────────── */

function detectArchitectureStyle(scan: RepoScan, repoType: RepositoryType): ArchitectureStyle {
  const has = (d: string) => scan.dirNames.has(d) || scan.dirTokens.has(d);

  if (repoType === 'kernel' || repoType === 'operating-system') {
    if (has('microkernel') || has('ukernel') || has('servers') || (has('ipc') && has('message'))) return 'microkernel';
    return 'monolithic';
  }
  if (repoType === 'compiler' || repoType === 'database' || repoType === 'library') return 'layered';
  if (has('gateway') && (has('services') || has('microservices'))) return 'microservices';
  if (has('events') || has('event-bus') || has('pubsub')) return 'event-driven';
  if (has('plugins') || has('extensions') || has('addons')) return 'plugin-based';
  if (repoType === 'frontend' || repoType === 'fullstack') {
    if (has('controllers') && has('views') && has('models')) return 'mvc';
  }
  if (repoType === 'cli') return 'monolithic';
  return 'monolithic';
}

/* ── Platform detection (evidence-based, never "node" by default) ── */

function detectPlatforms(
  scan: RepoScan,
  sig: RepoSignals,
  frameworks: string[],
  has: { frontend: boolean; backend: boolean },
  repoType: RepositoryType,
  primary: string,
): Platform[] {
  const p = new Set<Platform>();

  // Native CPU architectures from real path/build evidence.
  for (const a of sig.archTokens) p.add(a as Platform);
  if (sig.hasUefi) p.add('uefi');

  // Web / runtime targets.
  if (has.frontend || frameworks.some((f) => WEB_FRONTEND.includes(f))) { p.add('web'); p.add('browser'); }
  if (has.backend || frameworks.some((f) => WEB_BACKEND.includes(f))) p.add('node');
  if (frameworks.some((f) => f === 'React Native' || f === 'Expo')) { p.add('ios'); p.add('android'); }
  if (frameworks.some((f) => f === 'Tauri' || f === 'Electron')) { p.add('linux'); p.add('darwin'); p.add('windows'); }
  if (frameworks.some((f) => f === 'Wasm')) p.add('wasm');
  if (scan.dirNames.has('embedded') || scan.dirNames.has('firmware') || scan.dirNames.has('hal') || scan.dirNames.has('bsp')) p.add('embedded');

  const isNativeSystem = repoType === 'operating-system' || repoType === 'kernel' || repoType === 'embedded' || sig.hasFreestanding || sig.hasLinkerScript || sig.hasBootAsm;
  if (isNativeSystem && !p.has('embedded')) p.add('bare-metal');

  if (p.size === 0) {
    if (primary === 'TypeScript' || primary === 'JavaScript') p.add('node');
    else if (primary === 'C' || primary === 'C++' || primary === 'Rust' || primary === 'Go' || primary === 'Assembly') p.add('native');
    else p.add('native');
  }
  return [...p];
}

/* ── Entry point detection (real analysis, not a fixed list) ─────── */

function detectEntryPoints(root: string, scan: RepoScan): string[] {
  const found = new Map<string, string>(); // rel → label

  // package.json declared entry / bin.
  const pkgAbs = path.join(root, 'package.json');
  if (fs.existsSync(pkgAbs)) {
    try {
      const pkg = JSON.parse(readHead(pkgAbs, 8192)) as { main?: string; module?: string; bin?: unknown };
      if (typeof pkg.main === 'string') found.set(pkg.main, pkg.main);
      if (pkg.bin && typeof pkg.bin === 'object') for (const v of Object.values(pkg.bin)) if (typeof v === 'string') found.set(v, `${v} (bin)`);
      else if (typeof pkg.bin === 'string') found.set(pkg.bin, `${pkg.bin} (bin)`);
    } catch { /* ignore */ }
  }

  let read = 0;
  for (const c of scan.candidates) {
    if (read >= 100) break;
    const rel = c.rel.split(path.sep).join('/');
    if (c.ext === '.ld') {
      const m = readHead(c.abs, 4096).match(/ENTRY\s*\(\s*([A-Za-z_]\w*)\s*\)/);
      if (m) found.set(rel, `${rel} (ENTRY ${m[1]})`);
      read++;
      continue;
    }
    const t = readHead(c.abs, 6144);
    read++;
    if (c.ext === '.s' || c.ext === '.asm') {
      if (/(\.global|global)\s+_start|^_start\s*:/im.test(t)) found.set(rel, `${rel} (_start)`);
      continue;
    }
    if (c.ext === '.c' || c.ext === '.cc' || c.ext === '.cpp' || c.ext === '.h') {
      if (/\bkmain\s*\(/.test(t)) found.set(rel, `${rel} (kmain)`);
      else if (/\bkernel_main\s*\(/.test(t)) found.set(rel, `${rel} (kernel_main)`);
      else if (/\befi_main\b|\bEfiMain\b/.test(t)) found.set(rel, `${rel} (efi_main)`);
      else if (/\b_start\b/.test(t)) found.set(rel, `${rel} (_start)`);
      else if (/^\s*(?:int|void)\s+main\s*\(/m.test(t)) found.set(rel, `${rel} (main)`);
    } else if (c.ext === '.rs') {
      if (/\bfn\s+main\s*\(/.test(t)) found.set(rel, `${rel} (main)`);
      else if (/#!\[no_main\]|#\[no_mangle\][\s\S]{0,80}_start/.test(t)) found.set(rel, `${rel} (_start)`);
    } else if (c.ext === '.py') {
      if (/if\s+__name__\s*==\s*['"]__main__['"]/.test(t)) found.set(rel, `${rel} (__main__)`);
    } else if (c.ext === '.go') {
      if (/package\s+main/.test(t) && /func\s+main\s*\(/.test(t)) found.set(rel, `${rel} (main)`);
    } else if (['.ts', '.tsx', '.js', '.jsx'].includes(c.ext)) {
      if (/createRoot\s*\(|ReactDOM\.render\s*\(|\.render\s*\(\s*<|createApp\s*\(/.test(t)) found.set(rel, `${rel} (app entry)`);
    }
  }
  return [...found.values()].slice(0, 8);
}

/* ── Module discovery — major subsystems, not first folders ──────── */

const SUBSYSTEMS: [RegExp, string][] = [
  [/^(boot|bootloader|bootstrap)$/, 'Boot'],
  [/^(arch|platform|plat)$/, 'Arch/Platform'],
  [/^(mm|memory|vm|paging|heap|alloc)$/, 'Memory'],
  [/^(sched|scheduler|task|tasks|proc|process|processes|thread|threads)$/, 'Scheduler/Processes'],
  [/^(fs|vfs|filesystem)$/, 'Filesystem'],
  [/^(drivers?|dev|device)$/, 'Drivers'],
  [/^(net|network|networking|tcpip|socket)$/, 'Networking'],
  [/^(graphics|gpu|video|fb|framebuffer|display|vga|render)$/, 'Graphics'],
  [/^(ipc|message|messaging|mailbox)$/, 'IPC'],
  [/^(irq|interrupt|interrupts|idt|isr|trap)$/, 'Interrupts'],
  [/^(syscall|syscalls|abi)$/, 'Syscalls'],
  [/^(acpi)$/, 'ACPI'],
  [/^(pci)$/, 'PCI'],
  [/^(usb)$/, 'USB'],
  [/^(time|timer|timers|clock|pit|rtc)$/, 'Timers'],
  [/^(lib|klib|libk|libc)$/, 'Kernel Library'],
  [/^(shell|term|terminal|console|tty|serial)$/, 'Console/Terminal'],
  [/^(security|crypto|auth)$/, 'Security'],
];

function prettify(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function detectModules(root: string, scan: RepoScan, repoType: RepositoryType): string[] {
  // Canonical subsystems detected anywhere in the tree.
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const [re, label] of SUBSYSTEMS) {
    for (const token of scan.dirTokens) {
      if (re.test(token) && !seen.has(label)) { seen.add(label); canonical.push(label); break; }
    }
  }

  // Real structural modules (src subdirs, then top-level dirs).
  const structural: string[] = [];
  const srcDir = path.join(root, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) structural.push(prettify(e.name));
      }
    } catch { /* ignore */ }
  }
  for (const d of scan.topLevelDirs) {
    if (d === 'src' || d.length <= 1) continue;
    if (['docs', 'test', 'tests', 'examples', 'scripts', 'assets', 'public'].includes(d.toLowerCase())) continue;
    structural.push(prettify(d));
  }

  // For a system repo with clear subsystems, those subsystems ARE the
  // modules — appending raw folder names would just duplicate them.
  const isSystem = repoType === 'operating-system' || repoType === 'kernel' || repoType === 'embedded';
  const merged = (isSystem && canonical.length >= 3) ? canonical : [...canonical, ...structural];

  return [...new Set(merged)].slice(0, 20);
}

/* ── Build system, purpose, tech stack ───────────────────────────── */

function detectBuildSystem(root: string): string | null {
  const check: [string, string][] = [
    ['Makefile', 'Make'], ['makefile', 'Make'], ['CMakeLists.txt', 'CMake'], ['Cargo.toml', 'Cargo'],
    ['go.mod', 'Go build'], ['build.gradle', 'Gradle'], ['build.gradle.kts', 'Gradle'], ['pom.xml', 'Maven'],
    ['meson.build', 'Meson'], ['Kbuild', 'Kbuild'],
    ['vite.config.ts', 'Vite'], ['vite.config.js', 'Vite'], ['next.config.js', 'Next.js'], ['next.config.mjs', 'Next.js'],
    ['webpack.config.js', 'Webpack'], ['pyproject.toml', 'Python build'], ['tsconfig.json', 'TypeScript (tsc)'],
  ];
  for (const [file, name] of check) if (fs.existsSync(path.join(root, file))) return name;
  return null;
}

function extractReadmePurpose(root: string): string {
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) return '';
  try {
    const lines = readHead(readme, 8192).split('\n').map((l) => l.trim());
    const prose = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('![') && !l.startsWith('[!') && !l.startsWith('<') && !l.startsWith('```'));
    // Strip markdown emphasis but PRESERVE underscores inside words (x86_64).
    const clean = (s: string) => s.replace(/`/g, '').replace(/\*+/g, '').replace(/(^|[\s(])_([^_]+)_(?=[\s).,]|$)/g, '$1$2').slice(0, 300);
    if (prose) return clean(prose);
    const heading = lines.find((l) => l.startsWith('# '));
    if (heading) return clean(heading.replace(/^#\s*/, ''));
  } catch { /* ignore */ }
  return '';
}

const TYPE_NOUN: Record<RepositoryType, string> = {
  'operating-system': 'operating-system kernel',
  kernel: 'operating-system kernel',
  compiler: 'compiler / language toolchain',
  database: 'database engine',
  library: 'library',
  cli: 'command-line tool',
  frontend: 'frontend application',
  backend: 'backend service',
  fullstack: 'full-stack application',
  infrastructure: 'infrastructure project',
  'ai-framework': 'AI / ML framework',
  mobile: 'mobile application',
  desktop: 'desktop application',
  game: 'game',
  embedded: 'embedded firmware project',
  unknown: 'software project',
};

function synthesizePurpose(name: string, repoType: RepositoryType, primary: string, platforms: Platform[], modules: string[]): string {
  const noun = TYPE_NOUN[repoType];
  const plat = platforms.filter((p) => !['native', 'node'].includes(p)).slice(0, 3);
  const platStr = plat.length ? ` for ${plat.join(', ')}` : '';
  const mods = modules.slice(0, 4).join(', ');
  const modStr = mods ? `, organized around ${mods}` : '';
  const langStr = primary && primary !== 'unknown' ? ` written in ${primary}` : '';
  return `${name} is a ${noun}${langStr}${platStr}${modStr}.`;
}

function extractTechStack(root: string, primary: string, secondary: string[], frameworks: string[], buildSystem: string | null, platforms: Platform[]): string[] {
  const stack = new Set<string>();
  if (primary !== 'unknown') stack.add(primary);
  for (const s of secondary) stack.add(s);
  for (const f of frameworks) stack.add(f);
  if (buildSystem) stack.add(buildSystem);
  for (const p of platforms) if (['x86_64', 'x86', 'arm', 'arm64', 'riscv', 'uefi'].includes(p)) stack.add(p);
  if (fs.existsSync(path.join(root, 'tsconfig.json'))) stack.add('TypeScript');
  if (fs.existsSync(path.join(root, 'Dockerfile'))) stack.add('Docker');
  if (fs.existsSync(path.join(root, '.github', 'workflows'))) stack.add('GitHub Actions');
  return [...stack];
}

/* ── Public API ──────────────────────────────────────────────────── */

export function generateIdentity(
  projectId: string,
  root: string,
  profile: { frameworks: string[]; has: { frontend: boolean; backend: boolean; database: boolean; tests: boolean; docker: boolean; ci: boolean } },
): ProjectIdentity {
  const scan = scanRepository(root);
  const sig = collectSignals(root, scan);

  const sortedLangs = [...scan.langCounts.entries()].sort((a, b) => b[1] - a[1]);
  const primary = sortedLangs[0]?.[0] ?? 'unknown';
  const secondary = sortedLangs.slice(1, 4).map(([l]) => l);

  const repoType = detectRepositoryType(scan, sig, profile.frameworks, primary);
  const archStyle = detectArchitectureStyle(scan, repoType);
  const platforms = detectPlatforms(scan, sig, profile.frameworks, profile.has, repoType, primary);
  const buildSystem = detectBuildSystem(root);
  const modules = detectModules(root, scan, repoType);
  const entryPoints = detectEntryPoints(root, scan);
  const techStack = extractTechStack(root, primary, secondary, profile.frameworks, buildSystem, platforms);

  const name = path.basename(root);
  const readmePurpose = extractReadmePurpose(root);
  const purpose = readmePurpose || synthesizePurpose(name, repoType, primary, platforms, modules);

  return {
    id: projectId,
    name,
    purpose,
    repositoryType: repoType,
    primaryLanguage: primary,
    secondaryLanguages: secondary,
    buildSystem,
    frameworks: profile.frameworks,
    platforms,
    architectureStyle: archStyle,
    mainModules: modules,
    entryPoints,
    status: 'active',
    description: purpose || `${name} — ${repoType} in ${primary}`,
    technologyStack: techStack,
    generatedAt: new Date().toISOString(),
    fingerprint: computeFingerprint(root),
  };
}

function computeFingerprint(root: string): string {
  const markers = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Makefile', 'CMakeLists.txt'];
  return markers.map((m) => {
    try { return `${m}:${fs.statSync(path.join(root, m)).mtimeMs}`; } catch { return `${m}:0`; }
  }).join('|');
}

/* ── Persistence ─────────────────────────────────────────────────── */

export function loadIdentity(projectId: string): ProjectIdentity | null {
  return readJsonFile<ProjectIdentity | null>(IDENTITY_FILE(projectId), null);
}

export function saveIdentity(identity: ProjectIdentity): void {
  writeJsonFile(IDENTITY_FILE(identity.id), identity);
}

export function identityNeedsRegeneration(projectId: string, root: string): boolean {
  const existing = loadIdentity(projectId);
  if (!existing) return true;
  return existing.fingerprint !== computeFingerprint(root);
}

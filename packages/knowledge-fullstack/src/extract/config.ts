/**
 * ConfigExtractor — environment, dependencies, Docker, Compose, CI/CD
 * and build configuration from real manifest/config files.
 */

import { makeEntity, type Extractor, type LineMap, type SourceFile } from './extractor';
import type { Entity } from '../types';

const BUILD_CONFIG_NAMES = /^(vite\.config|tsconfig|tailwind\.config|postcss\.config|rollup\.config|webpack\.config|next\.config|svelte\.config|babel\.config|jest\.config|esbuild\.config)\./i;

export class ConfigExtractor implements Extractor {
  readonly id = 'config';
  appliesTo(f: SourceFile): boolean {
    const n = f.name.toLowerCase();
    return (
      n === 'package.json' || n === 'cargo.toml' || n === 'go.mod' || n === 'requirements.txt' || n === 'pyproject.toml' ||
      n.startsWith('.env') || n === 'dockerfile' || n.startsWith('docker-compose') || n === 'compose.yml' || n === 'compose.yaml' ||
      /(?:^|\/)\.github\/workflows\//i.test(f.relPath) || n === '.gitlab-ci.yml' || n === 'jenkinsfile' ||
      BUILD_CONFIG_NAMES.test(n)
    );
  }

  extract(f: SourceFile, lines: LineMap): Entity[] {
    const n = f.name.toLowerCase();
    if (n === 'package.json') return this.packageJson(f);
    if (n === 'cargo.toml') return this.cargoToml(f, lines);
    if (n === 'go.mod') return this.goMod(f, lines);
    if (n === 'requirements.txt') return this.requirements(f, lines);
    if (n.startsWith('.env')) return this.dotenv(f, lines);
    if (n === 'dockerfile') return this.dockerfile(f);
    if (n.startsWith('docker-compose') || n === 'compose.yml' || n === 'compose.yaml') return this.compose(f, lines);
    if (/(?:^|\/)\.github\/workflows\//i.test(f.relPath) || n === '.gitlab-ci.yml' || n === 'jenkinsfile') return this.ci(f);
    if (BUILD_CONFIG_NAMES.test(n)) return [makeEntity({ kind: 'build-config', layer: 'config', name: f.name, file: f, line: 1, summary: `Build config ${f.name}`, metadata: {} })];
    return [];
  }

  private packageJson(f: SourceFile): Entity[] {
    const out: Entity[] = [];
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(f.text);
    } catch {
      return [makeEntity({ kind: 'build-config', layer: 'config', name: f.name, file: f, line: 1, summary: `Manifest ${f.relPath}`, metadata: { parseError: true } })];
    }
    const scripts = Object.keys((pkg.scripts as object) ?? {});
    out.push(makeEntity({ kind: 'build-config', layer: 'config', name: (pkg.name as string) ?? f.relPath, file: f, line: 1, summary: `Package manifest ${(pkg.name as string) ?? f.relPath}`, metadata: { scripts, private: pkg.private } }));
    const add = (deps: Record<string, string> | undefined, dev: boolean) => {
      for (const [name, version] of Object.entries(deps ?? {})) {
        out.push(makeEntity({ kind: 'dependency', layer: 'config', name, file: f, line: 1, summary: `${dev ? 'dev ' : ''}dependency ${name}@${version}`, metadata: { version, dev, manifest: f.relPath } }));
      }
    };
    add(pkg.dependencies as Record<string, string>, false);
    add(pkg.devDependencies as Record<string, string>, true);
    return out;
  }

  private cargoToml(f: SourceFile, lines: LineMap): Entity[] {
    const out: Entity[] = [];
    const m = /\[dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(f.text);
    if (m) {
      for (const d of m[1].matchAll(/^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+)$/gm)) {
        const version = /["']([^"']+)["']/.exec(d[2])?.[1] ?? d[2].trim();
        out.push(makeEntity({ kind: 'dependency', layer: 'config', name: d[1], file: f, line: lines.lineAt(d.index ?? 0), summary: `crate ${d[1]} ${version}`, metadata: { version, manifest: f.relPath, ecosystem: 'cargo' } }));
      }
    }
    return out;
  }

  private goMod(f: SourceFile, lines: LineMap): Entity[] {
    const out: Entity[] = [];
    for (const d of f.text.matchAll(/^\s*([\w./\-]+)\s+v([\d][\w.\-]*)/gm)) {
      out.push(makeEntity({ kind: 'dependency', layer: 'config', name: d[1], file: f, line: lines.lineAt(d.index ?? 0), summary: `go module ${d[1]} v${d[2]}`, metadata: { version: d[2], manifest: f.relPath, ecosystem: 'go' } }));
    }
    return out;
  }

  private requirements(f: SourceFile, lines: LineMap): Entity[] {
    const out: Entity[] = [];
    for (const d of f.text.matchAll(/^\s*([A-Za-z0-9_.\-]+)\s*(?:[=<>!~]=?\s*([\d][\w.\-]*))?/gm)) {
      if (!d[1] || d[1].startsWith('#')) continue;
      out.push(makeEntity({ kind: 'dependency', layer: 'config', name: d[1], file: f, line: lines.lineAt(d.index ?? 0), summary: `pip ${d[1]}${d[2] ? ' ' + d[2] : ''}`, metadata: { version: d[2], manifest: f.relPath, ecosystem: 'pip' } }));
    }
    return out;
  }

  private dotenv(f: SourceFile, lines: LineMap): Entity[] {
    const out: Entity[] = [];
    for (const d of f.text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)) {
      out.push(makeEntity({ kind: 'env-var', layer: 'config', name: d[1], file: f, line: lines.lineAt(d.index ?? 0), summary: `env ${d[1]}`, metadata: { declaredIn: f.relPath } }));
    }
    return out;
  }

  private dockerfile(f: SourceFile): Entity[] {
    const from = [...f.text.matchAll(/^\s*FROM\s+(\S+)/gim)].map((m) => m[1]);
    const expose = [...f.text.matchAll(/^\s*EXPOSE\s+(\d+)/gim)].map((m) => m[1]);
    const env = [...f.text.matchAll(/^\s*ENV\s+([A-Z0-9_]+)/gim)].map((m) => m[1]);
    return [makeEntity({ kind: 'dockerfile', layer: 'deployment', name: f.relPath, file: f, line: 1, summary: `Dockerfile (${from.join(', ')})`, metadata: { from, expose, env } })];
  }

  private compose(f: SourceFile, lines: LineMap): Entity[] {
    const out: Entity[] = [];
    const text = f.text;
    const svcMatch = /^services:\s*$/m.exec(text);
    if (!svcMatch) return out;
    // Top-level service keys are indented exactly 2 spaces under `services:`.
    const after = text.slice(svcMatch.index);
    for (const m of after.matchAll(/^ {2}([A-Za-z0-9_.\-]+):\s*$/gm)) {
      const name = m[1];
      const block = after.slice(m.index, m.index + 800);
      const image = /^\s{4}image:\s*(\S+)/m.exec(block)?.[1];
      const ports = [...block.matchAll(/^\s{6,}-\s*["']?(\d+:\d+)/gm)].map((p) => p[1]);
      const dependsOn = [...block.matchAll(/depends_on:\s*(?:\[([^\]]*)\]|((?:\s*\n\s{6,}-\s*\S+)+))/g)].flatMap((d) =>
        (d[1] ?? d[2] ?? '').split(/[\n,]/).map((s) => s.replace(/[-\s'"]/g, '')).filter(Boolean),
      );
      out.push(makeEntity({ kind: 'compose-service', layer: 'deployment', name, file: f, line: lines.lineAt(svcMatch.index + m.index), summary: `Compose service ${name}${image ? ` (${image})` : ''}`, metadata: { image, ports, dependsOn } }));
    }
    return out;
  }

  private ci(f: SourceFile): Entity[] {
    const jobs = [...f.text.matchAll(/^ {2}([A-Za-z0-9_\-]+):\s*$/gm)].map((m) => m[1]).filter((j) => !['on', 'env', 'jobs', 'permissions', 'concurrency'].includes(j));
    const name = /^name:\s*(.+)$/m.exec(f.text)?.[1]?.trim() ?? f.name;
    return [makeEntity({ kind: 'ci-pipeline', layer: 'deployment', name, file: f, line: 1, summary: `CI pipeline ${name}`, metadata: { jobs, file: f.relPath } })];
  }
}

/**
 * Execution oracle — runs the REAL TypeScript spawn primitive over a
 * scenario file so the Python port can be diffed against the reference
 * rather than against someone's reading of it.
 *
 * The module under test is bundled from source by the caller, exactly as
 * scripts/process-timeout-test.mjs does, so this cannot drift from the
 * implementation it is meant to speak for.
 *
 * Usage: node exec_oracle.mjs <bundle.mjs> <scenarios.json>
 */
const [, , bundlePath, scenariosPath] = process.argv;
if (!bundlePath || !scenariosPath) {
  console.error('usage: exec_oracle.mjs <bundle.mjs> <scenarios.json>');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const m = await import(bundlePath);
const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8'));

/** Normalise a ProcessOutput into the fields both sides claim to agree on. */
const outcome = (r) => ({
  out: r.out,
  code: r.code,
  killed: r.killed ?? false,
  signal: r.signal ?? null,
  timedOut: r.timedOut ?? false,
});

const results = [];
for (const s of scenarios) {
  let value;
  try {
    switch (s.kind) {
      case 'shell':
        value = outcome(await m.safeShellWithCode(s.command, { cwd: s.cwd, timeoutMs: s.timeoutMs }));
        break;
      case 'shellStrict':
        value = { resolved: await m.safeShell(s.command, { cwd: s.cwd, timeoutMs: s.timeoutMs }) };
        break;
      case 'git':
        value = outcome(await m.git(s.args, { cwd: s.cwd, timeoutMs: s.timeoutMs }));
        break;
      case 'agent':
        value = outcome(await m.runAgent(s.bin, s.args, { cwd: s.cwd, timeoutMs: s.timeoutMs }));
        break;
      case 'installer':
        value = outcome(await m.runInstaller(s.bin, s.args, { cwd: s.cwd, timeoutMs: s.timeoutMs }));
        break;
      case 'parse': {
        const p = m.parseCommand(s.command);
        value = { ok: p.ok, bin: p.bin, args: p.args, reason: p.reason };
        break;
      }
      case 'agentResolve': {
        const r = m.resolveAgentBinary(s.name);
        value = { ok: r.ok, bin: r.bin, reason: r.reason };
        break;
      }
      case 'installerResolve': {
        const r = m.resolveInstallerBinary(s.name);
        value = { ok: r.ok, bin: r.bin, reason: r.reason };
        break;
      }
      case 'allowlists':
        value = {
          safe: [...m.SAFE_BINARIES].sort(),
          agent: [...m.AGENT_BINARIES].sort(),
          installer: [...m.INSTALLER_BINARIES].sort(),
          timeoutExit: m.TIMEOUT_EXIT_CODE,
        };
        break;
      case 'isPathLike':
        value = { value: m.isPathLike(s.name, s.platform) };
        break;
      case 'resolveExec': {
        const files = new Set(s.files);
        value = {
          value: m.resolveExecutableWith(s.name, {
            platform: s.platform,
            pathEnv: s.pathEnv,
            pathExt: s.pathExt,
            isExecutableFile: (c) => files.has(c),
          }),
        };
        break;
      }
      case 'spawnTarget': {
        const t = m.spawnTargetFor(s.resolved, s.args, s.platform);
        value = { file: t.file, args: t.args };
        break;
      }
      case 'quoteCmd':
        value = { value: m.quoteForCmd(s.arg) };
        break;
      case 'isCmdShim':
        value = { value: m.isCmdShim(s.resolved, s.platform) };
        break;
      case 'writableAncestors':
        value = { value: m.writableWithAncestors(s.target) };
        break;
      case 'detectDistro': {
        const d = m.detectDistro();
        value = { id: d.id, manager: d.manager, installArgs: d.installArgs };
        break;
      }
      case 'resolvePrivilege': {
        const r = m.resolvePrivilege(s.spec);
        value = { privilege: r.privilege, why: r.why };
        break;
      }
      case 'planInstall': {
        const r = m.planInstall({ name: s.entryName, homepage: s.homepage, install: s.spec ?? undefined });
        value = m.isPlan(r)
          ? { executable: r.executable, privilege: r.privilege, bin: r.bin, args: r.args, command: r.command, why: r.why }
          : { executable: false, reason: r.reason };
        break;
      }
      default:
        value = { unsupported: s.kind };
    }
  } catch (e) {
    value = { error: String(e && e.message ? e.message : e) };
  }
  results.push({ name: s.name, value });
}

process.stdout.write(JSON.stringify(results, null, 2));

import path from 'node:path';
import { startService } from './server';

/**
 * AURA backend entry point.
 * ==================================================================
 * Starts the local HTTP + SSE service. AURA is BYOAK-only: it has no
 * built-in model. The AI is unavailable until the user connects their
 * own provider with an API key in Settings.
 */

async function main() {
  const arg = process.argv[2];
  const noProject = arg === '--none';
  const openPath = noProject ? null : path.resolve(arg ?? process.cwd());
  const port = Number(process.env.AI_PORT ?? 4319);

  const shutdown = async () => {
    await svc.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const svc = await startService({
    port,
    onShutdownRequest: () => {
      // Reached through POST /shutdown — the graceful-stop path a Windows
      // supervisor uses because Windows has no SIGTERM. The service is
      // already listening by the time any request can arrive, so `svc` is
      // always assigned here.
      shutdown();
    },
  });

  process.stdout.write(`\nAURA backend ready on ${svc.url}\n`);

  if (openPath) {
    const existing = svc.manager.listProjects().find((pr) => path.resolve(pr.path) === openPath);
    const project = existing ?? svc.manager.addProject({ path: openPath }).project;
    process.stdout.write(`Opening project "${project.name}" (${project.path}) …\n`);
    svc.manager.open(project.id);
    const status = await svc.manager.whenIndexed();
    const profile = svc.manager.profile(project.id);
    process.stdout.write(`  type        : ${profile?.type ?? 'unknown'} · ${profile?.primaryLanguage ?? 'unknown'}\n`);
    process.stdout.write(`  coding      : ${status.coding.chunks} chunks\n`);
    process.stdout.write(`  fullstack   : ${status.fullstack.entities} entities, ${status.fullstack.relations} relations\n`);
    process.stdout.write(`  memory      : ${svc.manager.listMemory(project.id).length} items\n`);
  } else {
    process.stdout.write(`  no project open — add one in the Projects screen\n`);
  }

  const status = svc.manager.pipeline.providerStatus;
  process.stdout.write(`  provider    : ${status.type === 'none' ? 'none — connect an API key in Settings to enable AI' : status.label}\n`);
  process.stdout.write(`  projects    : ${svc.manager.listProjects().length} in registry\n`);
  process.stdout.write(`\nLaunch the app with \`npm run dev\` and open the AI tab.\n`);
}

main().catch((e) => {
  process.stderr.write(`AURA backend failed to start: ${(e as Error).message}\n`);
  process.exit(1);
});

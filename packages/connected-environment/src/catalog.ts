/**
 * catalog — everything the Connected Environment knows how to reach.
 * ==================================================================
 * This file is *knowledge*, not state. It says what each system does and
 * how the Hub would talk to it; it never asserts that a system is present.
 * Presence is measured at runtime by a transport (see registry.ts).
 *
 * Honesty rules enforced by this file's shape:
 *
 *   • `transport: 'local-process'` **with** a `probe` → the Hub can truly
 *     detect it, by running the real command and reading the real version.
 *   • `transport: 'local-process'` **without** a `probe` → the tool has no
 *     dependable executable on PATH across platforms, so the Hub reports
 *     `no-connector` rather than guessing "not installed" and being wrong.
 *   • `transport: 'http'` → a real, credential-free endpoint answers a
 *     liveness check (in practice: local model servers).
 *   • `transport: 'api-key'` → the Hub can hold a user key. For model
 *     providers this routes into the *existing* BYOAK provider system, so
 *     it is a real connection, not a new invented one.
 *   • `transport: 'oauth'` → requires an OAuth application this project
 *     does not have. Catalogued so missions can plan against it and so the
 *     Resolver can recommend it — never presented as connectable.
 *
 * Adding a system is a data change. No planner, orchestrator, registry or
 * UI code needs to be touched.
 */

import type { CapabilityId } from './capabilities';
import type {
  AuthKind,
  CatalogEntry,
  InstallSpec,
  LicenseKind,
  NodeCategory,
  TransportKind,
} from './types';

interface EntryInput {
  id: string;
  name: string;
  caps: CapabilityId[];
  summary: string;
  homepage: string;
  transport?: TransportKind;
  auth?: AuthKind;
  license?: LicenseKind;
  crossPlatform?: boolean;
  maintained?: boolean;
  probe?: string | [string, ...string[]];
  endpoint?: string;
  install?: InstallSpec;
}

function make(category: NodeCategory, input: EntryInput): CatalogEntry {
  const probe = input.probe
    ? typeof input.probe === 'string'
      ? { command: input.probe, args: ['--version'] }
      : { command: input.probe[0], args: input.probe.slice(1) }
    : undefined;
  return {
    id: input.id,
    name: input.name,
    category,
    capabilities: input.caps,
    transport: input.transport ?? 'local-process',
    auth: input.auth ?? 'none',
    license: input.license ?? 'open-source',
    crossPlatform: input.crossPlatform ?? true,
    maintained: input.maintained ?? true,
    summary: input.summary,
    homepage: input.homepage,
    probe,
    endpoint: input.endpoint,
    install: input.install,
  };
}

/* Install shorthands. Keeping these next to `make` means an entry states
   its package and privilege FLOOR in one line, and nothing else in the
   codebase gets to invent either (§25.4). */

/** Installed into the user's own npm prefix — usually. See §25.2 C1: the
 *  runtime re-checks writability, because a `/usr` prefix needs root. */
const npmGlobal = (pkg: string): InstallSpec =>
  ({ method: 'npm-global', package: pkg, privilege: 'user' });

/** A distro package. Always root, always guided, never executed by AURA. */
const systemPackage = (pkg: string, distro?: Record<string, string>): InstallSpec =>
  ({ method: 'system-package', package: pkg, privilege: 'root', distro });

/* ══════════════════════════════════════════════════════════════════
   Hub subsystems — always live, no network, no auth.
   These are what makes the Hub itself a node among nodes rather than a
   special case: a mission routes to them exactly like anything else.
   ══════════════════════════════════════════════════════════════════ */

const HUB: CatalogEntry[] = [
  make('hub', {
    id: 'aura-mission-control', name: 'Mission Control', transport: 'internal',
    caps: ['mission-control'], summary: 'Plans, approves and executes engineering missions.',
    homepage: 'https://github.com/Aura-hub-ai-native-workspace/aura-hub',
  }),
  make('hub', {
    id: 'aura-knowledge', name: 'Knowledge Fabric', transport: 'internal',
    caps: ['knowledge-graph'], summary: 'Structural knowledge graph of the open project.',
    homepage: 'https://github.com/Aura-hub-ai-native-workspace/aura-hub',
  }),
  make('hub', {
    id: 'aura-memory', name: 'Engineering Memory', transport: 'internal',
    caps: ['engineering-memory'], summary: 'Why past decisions were made, and what came of them.',
    homepage: 'https://github.com/Aura-hub-ai-native-workspace/aura-hub',
  }),
  make('hub', {
    id: 'aura-diagnosis', name: 'Diagnosis Engine', transport: 'internal',
    caps: ['diagnosis'], summary: 'Finds, explains and patches defects.',
    homepage: 'https://github.com/Aura-hub-ai-native-workspace/aura-hub',
  }),
  make('hub', {
    id: 'aura-governance', name: 'Engineering Governance', transport: 'internal',
    caps: ['governance'], summary: 'Health scoring, risk, audits and release readiness.',
    homepage: 'https://github.com/Aura-hub-ai-native-workspace/aura-hub',
  }),
];

/* ══════════════════════════════════════════════════════════════════
   Development — editors, agents, shells, runtimes, package managers
   ══════════════════════════════════════════════════════════════════ */

const DEVELOPMENT: CatalogEntry[] = [
  make('development', { id: 'git', name: 'Git', caps: ['source-control'], probe: 'git', summary: 'Distributed version control.', homepage: 'https://git-scm.com' }),
  make('development', { id: 'github-cli', name: 'GitHub CLI', caps: ['code-hosting', 'ci-cd', 'issue-tracker'], probe: 'gh', auth: 'cli-session', summary: 'Repositories, pull requests, issues and Actions from the terminal.', homepage: 'https://cli.github.com' }),
  make('development', { id: 'glab', name: 'GitLab CLI', caps: ['code-hosting', 'ci-cd', 'issue-tracker'], probe: 'glab', install: systemPackage('glab'), auth: 'cli-session', summary: 'GitLab projects, merge requests and pipelines from the terminal.', homepage: 'https://gitlab.com/gitlab-org/cli' }),

  make('development', { id: 'vscode', name: 'Visual Studio Code', caps: ['code-editor'], probe: 'code', license: 'free-tier', summary: 'Opens files, folders and diffs in the editor.', homepage: 'https://code.visualstudio.com' }),
  make('development', { id: 'cursor', name: 'Cursor', caps: ['code-editor', 'coding-agent'], probe: 'cursor', license: 'free-tier', summary: 'AI-native editor with in-repo code generation.', homepage: 'https://cursor.com' }),
  make('development', { id: 'claude-code', name: 'Claude Code', caps: ['coding-agent', 'terminal'], probe: 'claude', license: 'commercial', auth: 'cli-session', summary: 'Agentic coding in the terminal.', homepage: 'https://claude.com/claude-code' }),
  make('development', { id: 'codex-cli', name: 'Codex CLI', caps: ['coding-agent'], probe: 'codex', license: 'commercial', auth: 'cli-session', summary: 'Terminal coding agent.', homepage: 'https://github.com/openai/codex' }),
  make('development', { id: 'gemini-cli', name: 'Gemini CLI', caps: ['coding-agent'], probe: 'gemini', install: npmGlobal('@google/gemini-cli'), license: 'free-tier', auth: 'cli-session', summary: 'Terminal coding agent.', homepage: 'https://github.com/google-gemini/gemini-cli' }),
  make('development', { id: 'qwen-cli', name: 'Qwen Code', caps: ['coding-agent'], probe: 'qwen', install: npmGlobal('@qwen-code/qwen-code'), auth: 'cli-session', summary: 'Terminal coding agent.', homepage: 'https://github.com/QwenLM/qwen-code' }),
  make('development', { id: 'opencode', name: 'OpenCode', caps: ['coding-agent', 'terminal'], probe: 'opencode', install: npmGlobal('opencode-ai'), auth: 'cli-session', summary: 'Open-source terminal coding agent.', homepage: 'https://opencode.ai' }),

  make('development', { id: 'bash', name: 'Bash', caps: ['terminal'], probe: 'bash', summary: 'POSIX shell.', homepage: 'https://www.gnu.org/software/bash' }),
  make('development', { id: 'zsh', name: 'Zsh', caps: ['terminal'], probe: 'zsh', summary: 'Z shell.', homepage: 'https://zsh.sourceforge.io' }),
  make('development', { id: 'powershell', name: 'PowerShell', caps: ['terminal'], probe: ['pwsh', '--version'], summary: 'Cross-platform object shell.', homepage: 'https://microsoft.com/powershell' }),
  // Warp is a GUI terminal with no dependable cross-platform CLI on PATH —
  // catalogued for planning, honestly reported as having no connector.
  make('development', { id: 'warp', name: 'Warp', caps: ['terminal'], license: 'free-tier', summary: 'Modern GPU-accelerated terminal.', homepage: 'https://warp.dev' }),

  make('development', { id: 'node', name: 'Node.js', caps: ['language-runtime'], probe: 'node', summary: 'JavaScript and TypeScript runtime.', homepage: 'https://nodejs.org' }),
  make('development', { id: 'python', name: 'Python', caps: ['language-runtime'], probe: ['python3', '--version'], summary: 'Python interpreter.', homepage: 'https://python.org' }),
  make('development', { id: 'go', name: 'Go', caps: ['language-runtime', 'package-manager'], probe: ['go', 'version'], summary: 'Go toolchain.', homepage: 'https://go.dev' }),
  make('development', { id: 'java', name: 'Java', caps: ['language-runtime'], probe: ['java', '-version'], license: 'free-tier', summary: 'JVM runtime.', homepage: 'https://openjdk.org' }),
  make('development', { id: 'rust', name: 'Rust', caps: ['language-runtime', 'package-manager'], probe: 'cargo', summary: 'Cargo toolchain for Rust.', homepage: 'https://rust-lang.org' }),

  make('development', { id: 'npm', name: 'npm', caps: ['package-manager'], probe: 'npm', summary: 'Default Node package manager.', homepage: 'https://npmjs.com' }),
  make('development', { id: 'pnpm', name: 'pnpm', caps: ['package-manager'], probe: 'pnpm', install: npmGlobal('pnpm'), summary: 'Content-addressed Node package manager.', homepage: 'https://pnpm.io' }),
  make('development', { id: 'bun', name: 'Bun', caps: ['package-manager', 'language-runtime', 'testing-framework'], probe: 'bun', summary: 'JavaScript runtime, bundler and package manager.', homepage: 'https://bun.sh' }),

  make('development', { id: 'docker', name: 'Docker', caps: ['container-runtime', 'container-registry'], probe: 'docker', install: systemPackage('docker', { debian: 'docker.io' }), license: 'free-tier', summary: 'Builds and runs containers locally.', homepage: 'https://docker.com' }),
  make('development', { id: 'podman', name: 'Podman', caps: ['container-runtime'], probe: 'podman', install: systemPackage('podman'), summary: 'Daemonless container engine.', homepage: 'https://podman.io' }),
  make('development', { id: 'kubectl', name: 'Kubernetes CLI', caps: ['app-hosting', 'observability'], probe: ['kubectl', 'version', '--client'], auth: 'cli-session', summary: 'Deploys and inspects Kubernetes workloads.', homepage: 'https://kubernetes.io' }),
  make('development', { id: 'terraform', name: 'Terraform', caps: ['virtual-machine', 'secrets-management'], probe: 'terraform', install: systemPackage('terraform'), license: 'free-tier', auth: 'cli-session', summary: 'Declarative infrastructure provisioning.', homepage: 'https://terraform.io' }),

  make('development', { id: 'flutter', name: 'Flutter', caps: ['mobile-build', 'language-runtime'], probe: 'flutter', summary: 'Cross-platform application toolkit.', homepage: 'https://flutter.dev' }),
  make('development', { id: 'android-platform-tools', name: 'Android Platform Tools', caps: ['mobile-build'], probe: ['adb', 'version'], license: 'free-tier', summary: 'Device bridge for Android builds.', homepage: 'https://developer.android.com/studio' }),
  make('development', { id: 'xcode', name: 'Xcode', caps: ['mobile-build'], probe: ['xcodebuild', '-version'], crossPlatform: false, license: 'free-tier', summary: 'Apple platform build toolchain.', homepage: 'https://developer.apple.com/xcode' }),
  make('development', { id: 'android-studio', name: 'Android Studio', caps: ['code-editor', 'mobile-build'], license: 'free-tier', summary: 'Android IDE.', homepage: 'https://developer.android.com/studio' }),
  make('development', { id: 'unity', name: 'Unity', caps: ['game-engine'], license: 'free-tier', summary: 'Real-time 3D engine.', homepage: 'https://unity.com' }),
  make('development', { id: 'unreal', name: 'Unreal Engine', caps: ['game-engine'], license: 'free-tier', summary: 'Real-time 3D engine.', homepage: 'https://unrealengine.com' }),
];

/* ══════════════════════════════════════════════════════════════════
   Cloud — hosting, data, edge. CLI-backed ones are genuinely probeable;
   the rest are catalogued for planning and recommendation.
   ══════════════════════════════════════════════════════════════════ */

const CLOUD: CatalogEntry[] = [
  make('cloud', { id: 'vercel', name: 'Vercel', caps: ['static-hosting', 'serverless-compute', 'edge-network'], probe: 'vercel', install: npmGlobal('vercel'), license: 'free-tier', auth: 'cli-session', summary: 'Frontend and serverless hosting with preview deployments.', homepage: 'https://vercel.com' }),
  make('cloud', { id: 'netlify', name: 'Netlify', caps: ['static-hosting', 'serverless-compute'], probe: 'netlify', license: 'free-tier', auth: 'cli-session', summary: 'Static and edge-function hosting.', homepage: 'https://netlify.com' }),
  make('cloud', { id: 'cloudflare', name: 'Cloudflare', caps: ['edge-network', 'serverless-compute', 'object-storage', 'static-hosting'], probe: 'wrangler', install: npmGlobal('wrangler'), license: 'free-tier', auth: 'cli-session', summary: 'Workers, Pages, R2 and the edge network.', homepage: 'https://cloudflare.com' }),
  make('cloud', { id: 'fly', name: 'Fly.io', caps: ['app-hosting', 'virtual-machine'], probe: ['flyctl', 'version'], license: 'free-tier', auth: 'cli-session', summary: 'Runs containers close to users.', homepage: 'https://fly.io' }),
  make('cloud', { id: 'railway', name: 'Railway', caps: ['app-hosting', 'sql-database'], probe: 'railway', license: 'free-tier', auth: 'cli-session', summary: 'Deploys apps and managed databases from a repository.', homepage: 'https://railway.app' }),
  make('cloud', { id: 'supabase', name: 'Supabase', caps: ['sql-database', 'auth-service', 'object-storage'], probe: 'supabase', license: 'open-source', auth: 'cli-session', summary: 'Postgres, auth and storage as a managed service.', homepage: 'https://supabase.com' }),
  make('cloud', { id: 'firebase', name: 'Firebase', caps: ['nosql-database', 'auth-service', 'static-hosting', 'serverless-compute'], probe: 'firebase', license: 'free-tier', auth: 'cli-session', summary: 'App backend services from Google.', homepage: 'https://firebase.google.com' }),
  make('cloud', { id: 'aws', name: 'Amazon Web Services', caps: ['virtual-machine', 'object-storage', 'serverless-compute', 'sql-database', 'container-registry'], probe: ['aws', '--version'], license: 'commercial', auth: 'cli-session', summary: 'General-purpose cloud platform.', homepage: 'https://aws.amazon.com' }),
  make('cloud', { id: 'azure', name: 'Microsoft Azure', caps: ['virtual-machine', 'object-storage', 'serverless-compute', 'sql-database'], probe: ['az', 'version'], license: 'commercial', auth: 'cli-session', summary: 'General-purpose cloud platform.', homepage: 'https://azure.microsoft.com' }),
  make('cloud', { id: 'gcp', name: 'Google Cloud', caps: ['virtual-machine', 'object-storage', 'serverless-compute', 'sql-database'], probe: ['gcloud', 'version'], license: 'commercial', auth: 'cli-session', summary: 'General-purpose cloud platform.', homepage: 'https://cloud.google.com' }),
  make('cloud', { id: 'digitalocean', name: 'DigitalOcean', caps: ['virtual-machine', 'app-hosting', 'object-storage'], probe: ['doctl', 'version'], license: 'commercial', auth: 'cli-session', summary: 'Droplets, App Platform and Spaces.', homepage: 'https://digitalocean.com' }),
  make('cloud', { id: 'heroku', name: 'Heroku', caps: ['app-hosting', 'sql-database'], probe: 'heroku', license: 'commercial', auth: 'cli-session', summary: 'Git-push application hosting.', homepage: 'https://heroku.com' }),

  make('cloud', { id: 'render', name: 'Render', caps: ['app-hosting', 'static-hosting', 'sql-database'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Managed web services and databases.', homepage: 'https://render.com' }),
  make('cloud', { id: 'linode', name: 'Akamai Linode', caps: ['virtual-machine', 'object-storage'], transport: 'oauth', auth: 'oauth', license: 'commercial', summary: 'Compute instances and storage.', homepage: 'https://linode.com' }),
  make('cloud', { id: 'hetzner', name: 'Hetzner', caps: ['virtual-machine', 'object-storage'], transport: 'oauth', auth: 'api-key', license: 'commercial', summary: 'Low-cost European compute.', homepage: 'https://hetzner.com' }),
  make('cloud', { id: 'planetscale', name: 'PlanetScale', caps: ['sql-database'], probe: 'pscale', license: 'commercial', auth: 'cli-session', summary: 'Managed MySQL with branching.', homepage: 'https://planetscale.com' }),
  make('cloud', { id: 'neon', name: 'Neon', caps: ['sql-database'], probe: ['neonctl', '--version'], license: 'free-tier', auth: 'cli-session', summary: 'Serverless Postgres with branching.', homepage: 'https://neon.tech' }),
  make('cloud', { id: 'mongodb-atlas', name: 'MongoDB Atlas', caps: ['nosql-database'], probe: ['atlas', 'version'], license: 'free-tier', auth: 'cli-session', summary: 'Managed MongoDB clusters.', homepage: 'https://mongodb.com/atlas' }),
  make('cloud', { id: 'redis', name: 'Redis', caps: ['cache', 'vector-store'], probe: ['redis-cli', '--version'], summary: 'In-memory data store.', homepage: 'https://redis.io' }),
  make('cloud', { id: 'postgres', name: 'PostgreSQL', caps: ['sql-database', 'vector-store'], probe: ['psql', '--version'], summary: 'Relational database.', homepage: 'https://postgresql.org' }),
  make('cloud', { id: 'sqlite', name: 'SQLite', caps: ['sql-database'], probe: ['sqlite3', '--version'], summary: 'Embedded relational database.', homepage: 'https://sqlite.org' }),
  make('cloud', { id: 'bitbucket', name: 'Bitbucket', caps: ['code-hosting', 'ci-cd'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Repository hosting and pipelines.', homepage: 'https://bitbucket.org' }),
];

/* ══════════════════════════════════════════════════════════════════
   Design — all GUI/SaaS. Catalogued so design phases can plan and the
   Resolver can recommend; none is presented as connectable today.
   ══════════════════════════════════════════════════════════════════ */

const DESIGN: CatalogEntry[] = [
  make('design', { id: 'figma', name: 'Figma', caps: ['design-tool', 'prototyping'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Collaborative interface design and prototyping.', homepage: 'https://figma.com' }),
  make('design', { id: 'penpot', name: 'Penpot', caps: ['design-tool', 'prototyping'], transport: 'oauth', auth: 'oauth', license: 'open-source', summary: 'Open-source design and prototyping platform.', homepage: 'https://penpot.app' }),
  make('design', { id: 'excalidraw', name: 'Excalidraw', caps: ['diagramming'], transport: 'oauth', auth: 'none', license: 'open-source', summary: 'Hand-drawn style diagramming.', homepage: 'https://excalidraw.com' }),
  make('design', { id: 'canva', name: 'Canva', caps: ['image-editing', 'design-tool'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Template-driven graphic design.', homepage: 'https://canva.com' }),
  make('design', { id: 'framer', name: 'Framer', caps: ['prototyping', 'static-hosting'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Design-to-site prototyping and publishing.', homepage: 'https://framer.com' }),
  make('design', { id: 'spline', name: 'Spline', caps: ['design-tool'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: '3D scene design for the web.', homepage: 'https://spline.design' }),
  make('design', { id: 'photoshop', name: 'Adobe Photoshop', caps: ['image-editing'], transport: 'oauth', auth: 'oauth', license: 'commercial', summary: 'Raster image editing.', homepage: 'https://adobe.com/photoshop' }),
  make('design', { id: 'illustrator', name: 'Adobe Illustrator', caps: ['image-editing'], transport: 'oauth', auth: 'oauth', license: 'commercial', summary: 'Vector illustration.', homepage: 'https://adobe.com/illustrator' }),
];

/* ══════════════════════════════════════════════════════════════════
   Productivity — team surfaces. All OAuth-gated SaaS.
   ══════════════════════════════════════════════════════════════════ */

const PRODUCTIVITY: CatalogEntry[] = [
  make('productivity', { id: 'notion', name: 'Notion', caps: ['docs-workspace', 'issue-tracker'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Documents, wikis and lightweight databases.', homepage: 'https://notion.so' }),
  make('productivity', { id: 'confluence', name: 'Confluence', caps: ['docs-workspace'], transport: 'oauth', auth: 'oauth', license: 'commercial', summary: 'Team documentation space.', homepage: 'https://atlassian.com/software/confluence' }),
  make('productivity', { id: 'slack', name: 'Slack', caps: ['chat'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Team messaging and alerts.', homepage: 'https://slack.com' }),
  make('productivity', { id: 'discord', name: 'Discord', caps: ['chat'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Community and team messaging.', homepage: 'https://discord.com' }),
  make('productivity', { id: 'teams', name: 'Microsoft Teams', caps: ['chat', 'calendar'], transport: 'oauth', auth: 'oauth', license: 'commercial', summary: 'Team messaging and meetings.', homepage: 'https://microsoft.com/microsoft-teams' }),
  make('productivity', { id: 'jira', name: 'Jira', caps: ['issue-tracker'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Issue and sprint tracking.', homepage: 'https://atlassian.com/software/jira' }),
  make('productivity', { id: 'linear', name: 'Linear', caps: ['issue-tracker'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Fast issue tracking for product teams.', homepage: 'https://linear.app' }),
  make('productivity', { id: 'clickup', name: 'ClickUp', caps: ['issue-tracker', 'docs-workspace'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Work management platform.', homepage: 'https://clickup.com' }),
  make('productivity', { id: 'trello', name: 'Trello', caps: ['issue-tracker'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Board-based task tracking.', homepage: 'https://trello.com' }),
  make('productivity', { id: 'google-drive', name: 'Google Drive', caps: ['file-storage'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'File storage and sharing.', homepage: 'https://drive.google.com' }),
  make('productivity', { id: 'dropbox', name: 'Dropbox', caps: ['file-storage'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'File storage and sharing.', homepage: 'https://dropbox.com' }),
  make('productivity', { id: 'onedrive', name: 'OneDrive', caps: ['file-storage'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'File storage and sharing.', homepage: 'https://onedrive.com' }),
  make('productivity', { id: 'gmail', name: 'Gmail', caps: ['email'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Mail.', homepage: 'https://gmail.com' }),
  make('productivity', { id: 'outlook', name: 'Outlook', caps: ['email', 'calendar'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Mail and calendar.', homepage: 'https://outlook.com' }),
  make('productivity', { id: 'google-calendar', name: 'Google Calendar', caps: ['calendar'], transport: 'oauth', auth: 'oauth', license: 'free-tier', summary: 'Scheduling.', homepage: 'https://calendar.google.com' }),
];

/* ══════════════════════════════════════════════════════════════════
   AI — hosted providers route into the Hub's existing BYOAK provider
   system (a real, already-shipped connection). Local servers are probed
   over their real HTTP endpoints.
   ══════════════════════════════════════════════════════════════════ */

const AI: CatalogEntry[] = [
  make('ai', { id: 'anthropic', name: 'Anthropic', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'commercial', summary: 'Claude models.', homepage: 'https://anthropic.com' }),
  make('ai', { id: 'openai', name: 'OpenAI', caps: ['llm-inference', 'embeddings'], transport: 'api-key', auth: 'api-key', license: 'commercial', summary: 'GPT models and embeddings.', homepage: 'https://openai.com' }),
  make('ai', { id: 'google-gemini', name: 'Google Gemini', caps: ['llm-inference', 'embeddings'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Gemini models.', homepage: 'https://ai.google.dev' }),
  make('ai', { id: 'mistral', name: 'Mistral', caps: ['llm-inference', 'embeddings'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Open-weight and hosted models.', homepage: 'https://mistral.ai' }),
  make('ai', { id: 'groq', name: 'Groq', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Low-latency inference.', homepage: 'https://groq.com' }),
  make('ai', { id: 'deepseek', name: 'DeepSeek', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Open-weight reasoning models.', homepage: 'https://deepseek.com' }),
  make('ai', { id: 'qwen', name: 'Qwen', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Alibaba open-weight models.', homepage: 'https://qwen.ai' }),
  make('ai', { id: 'openrouter', name: 'OpenRouter', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Single gateway to many model providers.', homepage: 'https://openrouter.ai' }),
  make('ai', { id: 'cerebras', name: 'Cerebras', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'High-throughput inference.', homepage: 'https://cerebras.ai' }),
  make('ai', { id: 'nvidia-nim', name: 'NVIDIA NIM', caps: ['llm-inference', 'embeddings'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Hosted inference microservices.', homepage: 'https://build.nvidia.com' }),
  make('ai', { id: 'novita', name: 'Novita AI', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Hosted open-model inference.', homepage: 'https://novita.ai' }),
  make('ai', { id: 'siliconflow', name: 'SiliconFlow', caps: ['llm-inference'], transport: 'api-key', auth: 'api-key', license: 'free-tier', summary: 'Hosted open-model inference.', homepage: 'https://siliconflow.cn' }),

  make('ai', { id: 'ollama', name: 'Ollama', caps: ['local-llm', 'embeddings'], transport: 'http', endpoint: 'http://127.0.0.1:11434/api/version', license: 'open-source', summary: 'Runs open models on this machine.', homepage: 'https://ollama.com' }),
  make('ai', { id: 'lm-studio', name: 'LM Studio', caps: ['local-llm'], transport: 'http', endpoint: 'http://127.0.0.1:1234/v1/models', license: 'free-tier', summary: 'Local model server with an OpenAI-compatible API.', homepage: 'https://lmstudio.ai' }),
  make('ai', { id: 'anythingllm', name: 'AnythingLLM', caps: ['local-llm', 'vector-store'], transport: 'http', endpoint: 'http://127.0.0.1:3001/api/ping', license: 'open-source', summary: 'Local retrieval-augmented workspace.', homepage: 'https://anythingllm.com' }),
];

/* ══════════════════════════════════════════════════════════════════
   Browser — real binaries where a stable name exists on PATH.
   ══════════════════════════════════════════════════════════════════ */

const BROWSER: CatalogEntry[] = [
  make('browser', { id: 'chrome', name: 'Google Chrome', caps: ['browser'], probe: ['google-chrome', '--version'], license: 'free-tier', summary: 'Opens URLs and developer tooling.', homepage: 'https://google.com/chrome' }),
  make('browser', { id: 'chromium', name: 'Chromium', caps: ['browser'], probe: ['chromium', '--version'], summary: 'Open-source browser core.', homepage: 'https://chromium.org' }),
  make('browser', { id: 'firefox', name: 'Firefox', caps: ['browser'], probe: ['firefox', '--version'], summary: 'Open-source browser.', homepage: 'https://mozilla.org/firefox' }),
  make('browser', { id: 'brave', name: 'Brave', caps: ['browser'], probe: ['brave-browser', '--version'], license: 'free-tier', summary: 'Privacy-focused browser.', homepage: 'https://brave.com' }),
  make('browser', { id: 'edge', name: 'Microsoft Edge', caps: ['browser'], probe: ['microsoft-edge', '--version'], license: 'free-tier', summary: 'Chromium-based browser.', homepage: 'https://microsoft.com/edge' }),
  make('browser', { id: 'playwright', name: 'Playwright', caps: ['browser-automation', 'testing-framework'], probe: ['playwright', '--version'], summary: 'Cross-browser automation and end-to-end testing.', homepage: 'https://playwright.dev' }),
  make('browser', { id: 'puppeteer', name: 'Puppeteer', caps: ['browser-automation'], summary: 'Chromium automation library — consumed as a dependency, not a CLI.', homepage: 'https://pptr.dev' }),
  make('browser', { id: 'curl', name: 'curl', caps: ['http-client'], probe: ['curl', '--version'], summary: 'Calls HTTP APIs and inspects responses.', homepage: 'https://curl.se' }),
];

/* ══════════════════════════════════════════════════════════════════ */

export const CATALOG: CatalogEntry[] = [
  ...HUB, ...DEVELOPMENT, ...CLOUD, ...DESIGN, ...PRODUCTIVITY, ...AI, ...BROWSER,
];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

export function entriesProviding(capability: CapabilityId): CatalogEntry[] {
  return CATALOG.filter((e) => e.capabilities.includes(capability));
}

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  hub: 'Hub Subsystems',
  development: 'Development',
  cloud: 'Cloud',
  design: 'Design',
  productivity: 'Productivity',
  ai: 'AI',
  browser: 'Browser',
};

/**
 * Whether the Hub can complete a real connection for this entry today.
 * The single source of truth for "would clicking Connect do something".
 * The UI must never offer Connect where this returns false.
 */
export function isConnectable(entry: CatalogEntry): boolean {
  switch (entry.transport) {
    case 'internal':
      return true;
    case 'local-process':
      return Boolean(entry.probe);
    case 'http':
      return Boolean(entry.endpoint);
    case 'api-key':
      // Routed into the already-shipped BYOAK provider system.
      return true;
    case 'oauth':
      // No OAuth application exists for this project. Catalogued only.
      return false;
  }
}

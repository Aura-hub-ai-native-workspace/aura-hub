/**
 * capabilities — the Connected Environment's capability vocabulary.
 * ==================================================================
 * A capability is *what a system can do for a mission*, never the system
 * itself. The whole architecture depends on this indirection:
 *
 *   • The Mission Planner plans against capabilities, not products.
 *     A task says "I need `deploy-host`", never "I need Vercel".
 *   • The Environment Manager binds a task to whichever connected node
 *     provides that capability at execution time.
 *   • The Resolver answers a missing capability with ranked candidates
 *     rather than a dead end.
 *
 * This is why a new integration is additive: it declares the capabilities
 * it provides and every existing plan can immediately route to it. No
 * planner, orchestrator or UI code changes.
 *
 * Adding a capability here is a deliberate act — it widens the vocabulary
 * the planner can express. Keep the list about *jobs*, not brands.
 */

export const CAPABILITIES = {
  /* ── source, build, run ─────────────────────────────────────────── */
  'source-control': 'Track and version source history',
  'code-hosting': 'Host repositories remotely and review changes',
  'ci-cd': 'Run pipelines on push, tag or schedule',
  'code-editor': 'Open and edit project files',
  'coding-agent': 'Generate and modify code from natural language',
  terminal: 'Run shell commands in a project directory',
  'language-runtime': 'Execute a program in a given language',
  'package-manager': 'Resolve, install and publish dependencies',
  'testing-framework': 'Run automated tests and report results',
  'mobile-build': 'Compile and sign a mobile application',
  'game-engine': 'Build interactive real-time applications',

  /* ── containers and infrastructure ──────────────────────────────── */
  'container-runtime': 'Build and run containers locally',
  'container-registry': 'Store and distribute container images',
  'app-hosting': 'Host a long-running server application',
  'static-hosting': 'Serve a built static site or SPA',
  'serverless-compute': 'Run functions without managing servers',
  'virtual-machine': 'Provision raw compute instances',
  'object-storage': 'Store and serve unstructured files',
  'edge-network': 'Cache and route traffic at the edge',
  'secrets-management': 'Store credentials outside the repository',
  observability: 'Collect logs, metrics and traces from a running system',

  /* ── data ───────────────────────────────────────────────────────── */
  'sql-database': 'Persist relational data',
  'nosql-database': 'Persist document or key-value data',
  cache: 'Serve hot data with low latency',
  'vector-store': 'Store and search embeddings',
  'auth-service': 'Authenticate and authorize end users',

  /* ── design ─────────────────────────────────────────────────────── */
  'design-tool': 'Produce interface designs and design systems',
  prototyping: 'Build an interactive prototype of a flow',
  diagramming: 'Draw architecture and flow diagrams',
  'image-editing': 'Create and edit raster or vector assets',

  /* ── productivity ───────────────────────────────────────────────── */
  'docs-workspace': 'Write and share long-form documents',
  'issue-tracker': 'Track work items, sprints and status',
  chat: 'Notify and converse with a team',
  'file-storage': 'Store and share arbitrary files with a team',
  email: 'Send and receive mail',
  calendar: 'Schedule events and reminders',

  /* ── intelligence ───────────────────────────────────────────────── */
  'llm-inference': 'Run a hosted large language model',
  'local-llm': 'Run a language model on this machine',
  embeddings: 'Turn text into vectors for retrieval',

  /* ── web ────────────────────────────────────────────────────────── */
  browser: 'Open and render a web page for a human',
  'browser-automation': 'Drive a browser programmatically',
  'http-client': 'Call an HTTP API and inspect the response',

  /* ── the Hub's own subsystems (internal execution nodes) ────────── */
  'knowledge-graph': 'Answer questions about the codebase structure',
  'engineering-memory': 'Recall why past decisions were made',
  'mission-control': 'Plan, approve and execute engineering missions',
  diagnosis: 'Find and explain defects in the codebase',
  governance: 'Audit health, risk and release readiness',
} as const;

export type CapabilityId = keyof typeof CAPABILITIES;

export function describeCapability(id: CapabilityId): string {
  return CAPABILITIES[id];
}

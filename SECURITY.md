# Security Policy

## Supported Versions

AURA Hub is pre-1.0 and moves quickly. Security fixes are made against
`main` and the latest release only — there is no long-term support
branch yet.

| Version | Supported |
|---|---|
| `main` / latest release | ✅ |
| Older releases | ❌ |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately using
[GitHub Security Advisories](https://github.com/Aura-hub-ai-native-workspace/aura-hub/security/advisories/new)
for this repository. If that's unavailable to you, contact the
repository owner directly: [@Gokulanand-art](https://github.com/Gokulanand-art).

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is ideal)
- The affected version/commit

You should expect an initial response within **5 business days**. We'll
work with you to understand and validate the issue, and to agree on a
disclosure timeline once a fix is available. Please give us a reasonable
window to ship a fix before any public disclosure.

## Security Model — what to know before reporting

Understanding how AURA actually handles credentials and network access
helps you judge severity accurately:

### Bring-your-own-key (BYOAK), always

AURA has **no built-in AI model and no hidden default API account**.
There is no AI capability until a user connects one of the supported
providers with their own API key
(`packages/ai-service/src/provider/registry.ts`). AURA's own servers
never see your provider keys — they never leave your machine except in
direct requests to the provider you configured.

### Credential storage

Provider API keys are encrypted at rest with AES-256-GCM
(`packages/ai-service/src/provider/credentialStore.ts`) and stored
locally at `~/.aura/providers.json`. Keys are never logged, never
included in error messages (see the
[provider error translator](docs/architecture/PROVIDER_INTEGRATION.md)
— provider errors are always translated to a friendly message, never
surfaced as raw payloads that could carry sensitive detail), and never
transmitted anywhere except directly to the provider's own API over TLS.

### Local-only backend

`packages/ai-service` runs as a local HTTP + SSE service bound to
`127.0.0.1` only — it is not designed to be exposed to a network and has
no authentication layer of its own, because it isn't meant to accept
connections from anything other than the local desktop app. Do not
reverse-proxy or expose this port to an untrusted network.

### No telemetry

AURA does not send usage analytics or telemetry to any third party.
Request tracing exists only to power the AI pipeline's own in-app
performance metrics (latency, token usage) and stays on your machine.

### Native shell surface

The Tauri Rust layer (`apps/desktop/src-tauri`) is intentionally thin —
its job today is to host the web environment. Any new native command
(file access, process execution, system hooks) is a security-relevant
surface and should be scoped as narrowly as possible; flag anything that
looks broader than it needs to be in review.

## Scope

In scope:
- The desktop app (`apps/desktop`)
- The local AI service and provider adapters (`packages/ai-service`)
- Credential storage and encryption (`packages/ai-service/src/provider/credentialStore.ts`)
- The knowledge engines and workflow/automation execution paths

Out of scope:
- Vulnerabilities in a third-party AI provider's own API or infrastructure
- Issues that require an attacker to already have local code execution
  on the user's machine (the local backend's threat model assumes a
  trusted local machine, same as any other local dev tool)

# Running AURA's services in Docker

The desktop app starts its own Python backend and Node AI service and does not need Docker. This page covers running those two services as containers instead: headless, on a server, or for development.

## Quick start

```sh
cp .env.example .env              # optional; every value has a default
docker compose up -d --build      # backend on 127.0.0.1:4320, AI service on 127.0.0.1:4319
curl http://127.0.0.1:4320/health
curl http://127.0.0.1:4319/health
```

To also run Ollama in a container, set `AURA_OLLAMA_BASE_URL=http://ollama:11434` in `.env`, then run:

```sh
docker compose --profile ollama up -d --build
```

Without the profile, the services reach an Ollama running on the host through `host.docker.internal`.

## What runs

| Service | Image | Port | Health |
|---|---|---|---|
| `backend` | `docker/backend.Dockerfile` (Python 3.12, Starlette/uvicorn) | 4320 | `GET /health` |
| `ai-service` | `docker/ai-service.Dockerfile` (Node 22, esbuild bundle) | 4319 | `GET /health` |
| `ollama` (profile `ollama`) | `ollama/ollama` | 11434 | — |

- Both AURA services store their state in the `aura-home` volume, mounted at `/data`. This is the container's equivalent of `~/.aura`.
- Both run as UID 1000.

## Configuration

| Variable | Default in containers | Meaning |
|---|---|---|
| `AURA_BIND_HOST` | `0.0.0.0` | Interface the services listen on. Outside Docker the default is `127.0.0.1`. |
| `AURA_OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Where both services look for Ollama. |
| `AURA_INSTANCE_TOKEN` | empty | When set, every backend route except `/health` requires the header `x-aura-instance-token`. |
| `AURA_HOME` | `/data` | State directory. |
| `AURA_EXTRAS` (build arg) | empty | Backend extras to install, e.g. `multimodal,artifacts`. |
| `AURA_ENVIRONMENT_PORT`, `AI_PORT` | `4320`, `4319` | Host ports in `compose.yaml`. |

## Security

- Ports are published on `127.0.0.1` only.
- The services have no login of their own. Set `AURA_INSTANCE_TOKEN`, and do not expose the ports on a public interface without an authenticating proxy in front.

## Limitations

- **The environment inventory describes the container.** The backend's job includes discovering tools, runtimes and package managers on the machine it runs on. Inside a container, that machine is the container, not your workstation.
- **The desktop app does not connect to these containers.** It launches its own backend and refuses one it did not start (the ownership check in `apps/desktop/src-tauri/src/service.rs`). Stop the containers, or change their ports, before starting the desktop app on the same machine.
- **Worker runs are not available in these images.** OpenCode, Claude Code and the other worker CLIs are not installed in them. To run workers inside containers, use the run sandbox below, which the desktop app manages itself.

## Run sandbox: coding agents inside containers

Separately from the compose services above, the desktop app can run each coding-agent task inside a throwaway container. It's set in **Settings → AI Runtime → Run isolation**:

| Setting | What happens |
|---|---|
| **Automatic** (default) | A container when Docker is available and the sandbox image is ready; otherwise the run happens on this computer, and the run's output says why. |
| **Container only** | Always a container. A run that cannot get one is not started. |
| **This computer** | No container, as in earlier versions. |

`AURA_ISOLATION=auto|container|host` overrides the setting, for headless setups and CI.

### What a worker can see

The container is started with `docker run --rm` as your own user ID, so the files it writes are owned by you. It sees:

- the project it is working on, read-write, at the same absolute path as on your machine
- its own install, read-only (your installed OpenCode, Claude Code, Codex, Kilo, Qwen or Cursor Agent, not a copy)
- its own sign-in folders, read-write so tokens can refresh: for example `~/.config/opencode` and `~/.local/share/opencode`, or `~/.claude` and `~/.claude.json`
- AURA's per-run governance folder, so the scope plugin and hooks keep working and AURA reads their action log live
- `~/.gitconfig`, read-only

Nothing else. Your other projects, `~/.ssh`, your documents and the rest of your home directory are not there. This also hides services that run on your computer. An MCP server a worker would normally start from your machine, or a server on your machine's `localhost`, is not reachable from inside the container. A task that depends on one should run with isolation set to **This computer**. The home directory is an empty in-memory folder, and the image itself is read-only.

Further limits:
- **Privileges:** all Linux capabilities are dropped and `no-new-privileges` is set.
- **Resources:** CPU, memory (75% of the machine) and process count are capped.
- **Secrets:** API keys are passed by name, so their values never appear on a command line. A proxy set on your machine is not passed in.

### Network

The task's network policy is enforced inside the container, and proven before the worker starts:

| Policy | Container |
|---|---|
| none | normal network; reported as ungoverned |
| `deny` | `--network none`, checked from inside: a connection to an IP address and a DNS lookup must both fail |
| `allowlist` | `--network none` plus AURA's egress gateway, reached through its socket; checked from inside that it is reachable, refuses unlisted hosts, and has no way around it |

### The image

`aura-sandbox:<hash>` is built locally the first time it is needed, or with **Prepare now** in Settings. It takes about a minute. The image is defined in `backend/aura/governance/container.py`; its tag is a hash of that definition, so a change builds a new image. It contains Node 22, Python 3, Git, ripgrep and build tools. `sandbox.execute` commands also run in it, with no network. `cargo` and `go` are not in the image, so those commands run on this computer in Automatic mode and are refused in Container only mode.

### Stopping and cleanup

STOP ends the worker and removes its container. Containers left behind by an AURA process that exited abnormally are removed the next time a run starts. Every container AURA creates is labelled `aura.sandbox`, and cleanup touches nothing else.

### Platforms

Linux only. On macOS and Windows your coding agents are macOS or Windows programs, which cannot run inside a Linux container. Supporting those platforms would need the agents installed inside the image instead, which is a different design that has not been tested. Settings shows this, and runs continue on this computer.

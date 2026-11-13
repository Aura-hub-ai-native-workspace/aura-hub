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
- **Worker runs are not available in these images.** OpenCode, Claude Code and the other worker CLIs are not installed. Running workers inside isolated containers is a separate feature, the run sandbox, which is planned next.

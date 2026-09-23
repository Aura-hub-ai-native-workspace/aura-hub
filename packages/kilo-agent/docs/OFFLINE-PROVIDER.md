# Offline provider — Ollama (local) for Kilo Code

Default endpoint: `http://127.0.0.1:11434/v1` (local Ollama daemon, NOT Ollama Cloud).

> Local Ollama vs Ollama Cloud: use the `ollama/` provider for a local daemon started
> with `ollama serve`. Anything named `ollama-cloud/...` is the hosted Kilo Gateway/BYOK
> path and is FORBIDDEN in this offline package.

## Run it

```powershell
ollama serve
ollama pull qwen3-coder:30b
ollama list
```

Kilo recommendation is `qwen3-coder:30b` (use `ollama/qwen3-coder:30b` as the model id).
Set context window (`num_ctx`) to at least 32k — Ollama truncates short by default.
API timeout default is 10 minutes; raise it for slow local hardware.

## kilo.json (this package)

`model: ollama/qwen3-coder:30b`, `provider.ollama.baseURL: http://127.0.0.1:11434/v1`,
all three local coder models registered with `tool_call: true`,
`limit.context: 32768, limit.output: 8192`. No Gateway, no BYOK, no account.

Custom model example (same shape Kilo expects):

```json
{
  "model": "ollama/my-finetune:latest",
  "provider": {
    "ollama": {
      "models": {
        "my-finetune:latest": {
          "name": "My Fine-tuned Model",
          "tool_call": true,
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  }
}
```

## Bridge to AURA central agent

`config/aura-providers.json` mirrors the same endpoint for
`backend/aura/central_agent/model_routing.py` (`~/.aura/agent/providers.json`
shape). The key env is a no-key sentinel (`AURA_OLLAMA_NO_KEY`) — local Ollama
needs no API key, matching AURA's `OllamaAdapter`.

## Offline boundary (read before claiming "fully offline")

Local inference keeps MODEL requests on your endpoint. It does NOT automatically
make sign-in, software updates, remote MCP servers, telemetry, browser tools,
Cloud Agents, or hosted review local. This package removes those defaults; keep
them off.

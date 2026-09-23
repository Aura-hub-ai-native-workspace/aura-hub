# Offline provider — Ollama (local)

Default endpoint: `http://127.0.0.1:11434/v1` (OpenAI-compatible).

## Why Ollama is the default

- No account, no API key, no cloud. Matches AURA's existing `OllamaAdapter`
  (`packages/ai-service/src/provider/adapters/ollama.ts`, default `http://127.0.0.1:11434`).
- OpenAI-compatible `/v1` path is what opencode expects (`npm: @ai-sdk/openai-compatible`).

## Run it

```powershell
ollama serve
ollama pull qwen3-coder:30b
ollama pull qwen3:4b
ollama list
```

Point AURA at the same server: Settings → AI Provider → Ollama → `http://127.0.0.1:11434`,
or `AURA_OLLAMA_BASE_URL=http://127.0.0.1:11434`.

## opencode.json (this package)

`model: ollama/qwen3-coder:30b`, `small_model: ollama/qwen3:4b`, `share: disabled`,
`autoupdate: false`. Only the `ollama` provider is declared — every cloud
provider (Zen, Go, Anthropic, OpenAI, etc.) is removed, not just disabled.

If tool calls misbehave on a small model, raise `num_ctx` (16k–32k) and prefer a
coder variant (`qwen3-coder`, `qwen2.5-coder`, `deepseek-coder`).

## Bridge to AURA central agent

`config/aura-providers.json` mirrors the same endpoint for
`backend/aura/central_agent/model_routing.py` (`~/.aura/agent/providers.json`
shape: `id/baseUrl/model/apiKeyEnv`). Copy it there when wiring the agent layer;
the key env is intentionally a no-key sentinel (`AURA_OLLAMA_NO_KEY`).

# AURA Hub — Local Inference via a Private llama-server (L40S)

> Operator / developer guide. AURA Hub is the orchestration and governance
> layer; a llama-server on private infrastructure (e.g. an NVIDIA L40S
> machine) is the inference engine. AURA talks to it over HTTP through the
> **Local LLaMA** provider (`local-llama`), which reuses the existing
> OpenAI-compatible provider stack. Nothing here embeds, downloads,
> installs or manages models — the L40S machine already owns inference.
>
> Placeholders like `<L40S-IP>` and `<PORT>` are intentional: no real
> deployment address belongs in the repository.

---

## 1. L40S server requirements

- An NVIDIA L40S machine (or any host with enough VRAM for your model) on
  a private network reachable from the AURA Hub machine.
- Outbound internet is **not** required for inference once the model file
  is on the server.

## 2. llama-server requirement

- `llama-server` from the llama.cpp project
  (`https://github.com/llama.cpp/llama.cpp`), built with CUDA support so
  the model runs on the L40S GPU.
- It must expose the OpenAI-compatible API (`/v1/models`,
  `/v1/chat/completions`, including `stream: true` SSE streaming).

## 3. Model requirement

- Any GGUF open-weight model the server can hold, e.g. a Qwen 3.5 27B
  quant. AURA reads the served model id from `/v1/models` — the id is
  never assumed, so whatever the server publishes is what AURA offers.

## 4. Check the running server

On the L40S machine:

```sh
nvidia-smi
ps aux | grep '[l]lama-server'
```

`nvidia-smi` should show the GPU and the model processes; the `ps` line
should show the `llama-server` command with its `--model`, `--port` and
`--host` flags.

## 5. Find the listening port

```sh
ss -lntp | grep llama-server
```

Note the port (llama.cpp defaults to `8080`). The bind address matters
(see §9): for AURA access over the LAN the server must listen on a
non-loopback interface.

## 6. Verify `/v1/models` (on the server itself)

```sh
curl http://127.0.0.1:<PORT>/v1/models
```

Expect `{"data":[{"id":"<model-id>",...}]}`. An empty `data` array means
the server is up but no model is loaded — AURA will honestly report
`no-models`, not "connected".

## 7. Verify `/v1/chat/completions` (on the server itself)

```sh
curl http://127.0.0.1:<PORT>/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"Reply with: ok"}],"stream":false,"max_tokens":16}'
```

Then the streaming shape:

```sh
curl -N http://127.0.0.1:<PORT>/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"Reply with: ok"}],"stream":true,"max_tokens":16}'
```

Expect `data:` SSE chunks ending in `data: [DONE]`.

## 8. Configure AURA Hub

From the AURA machine, first confirm reachability:

```sh
curl http://<L40S-IP>:<PORT>/v1/models
```

Then either use **AI Settings → Connect Provider → Local LLaMA**
(the API key field is optional — leave it empty when the server needs no
authentication), or configure the environment before starting the
service:

```sh
export AURA_LOCAL_LLM_BASE_URL="http://<L40S-IP>:<PORT>/v1"
export AURA_LOCAL_LLM_MODEL="<model-id>"   # used by live checks / docs
export AURA_LOCAL_LLM_API_KEY=""            # only if the server requires one
```

Notes:

- A trailing `/v1` (or slash) in the URL is accepted and normalized.
- Only `http(s)` origins without embedded credentials are accepted;
  anything else fails validation deterministically.
- With `AURA_LOCAL_LLM_API_KEY` set, the provider auto-connects at
  startup through the same path as a manual connect. Keyless servers are
  connected explicitly with an empty key.
- After connecting, discover models and select the served model id in
  AI Settings. Model routing, context assembly, policy, approval,
  evidence and audit are unchanged — the local model is simply another
  routed provider.

## 9. Network / security considerations

Recommended deployment:

```text
AURA machine
  ↓ college / private network
L40S server (llama-server)
```

- Do **not** expose llama-server to the public internet
  (`0.0.0.0` without controls).
- If the server must bind a non-loopback interface for AURA access,
  restrict it with firewall rules / network ACLs to the trusted AURA
  client(s) only.
- Prefer authentication (`--api-key` server-side, stored once in AURA's
  encrypted credential store) whenever the network path is shared.
- AURA never logs the key and never sends it anywhere except the
  configured llama-server as a Bearer token — and sends no
  `Authorization` header at all when no key is configured.
- Sovereignty is a deployment property: with the Local LLaMA provider
  active and no cloud provider connected, inference stays on the private
  endpoint. Neither Tauri nor the provider alone guarantees
  air-gapped operation — the network policy does.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Could not reach the local llama-server` | Server down, wrong IP/port, or firewall. Re-run §6–§8. |
| `…timed out…` | Server overloaded or model still loading; retry, or check VRAM with `nvidia-smi`. |
| `requires an API key (401/403)` | Server has `--api-key` set — configure the same key in AURA, or remove server-side auth on a trusted network. |
| `published no models` | Server up but model not loaded — check the `--model` path and server logs. |
| `HTTP 404` on chat | Wrong model id — re-discover models and pick a served id. |
| `Not a valid server URL` / `Only http(s)…` / `must not embed credentials` | Fix `AURA_LOCAL_LLM_BASE_URL` (see §8 notes). |
| `rate limited (429)` | Server-side limits; wait and retry. |

Run the automated suite (mock servers, no L40S needed):

```sh
node scripts/run-ts.mjs scripts/verify-local-llama.ts
```

Run the opt-in live check against the real server:

```sh
AURA_LOCAL_LLM_BASE_URL="http://<L40S-IP>:<PORT>/v1" \
AURA_LOCAL_LLM_MODEL="<model-id>" \
AURA_LOCAL_LLM_API_KEY="<only-if-needed>" \
node scripts/run-ts.mjs scripts/verify-local-llama.ts
```

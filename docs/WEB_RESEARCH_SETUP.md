# Connecting AURA to web search

AURA answers every general and project chat question with web research. It ships **no search engine and
suggests none**: you point it at a SearXNG-compatible gateway, and until you do, answers say plainly that
research was unavailable and are not backed by sources.

## What AURA needs

An HTTP endpoint that answers

    GET <endpoint>?q=<urlencoded query>&format=json   →   200 {"results": [{"title", "url", "content"}, …]}

`results` may be empty (reported as "found nothing", not as an outage). Anything else — HTML, a non-JSON body,
a JSON object without a `results` list — is reported as "not a SearXNG-compatible search endpoint".
No credentials are accepted in the address (it is stored in a plain file).

## Configure it (any one of these)

1. In the app: when an answer says research is unavailable, paste the address into the form under the notice and
   press **Test and save**. AURA sends one real test query first and saves only if it answers like a gateway.
2. File: `<AURA_HOME>/web.json` (default `~/.aura/web.json`): `{"searchEndpoint": "http://127.0.0.1:8888/search"}`
3. Environment: `AURA_SEARCH_ENDPOINT=http://127.0.0.1:8888/search` (overrides the file; the form then refuses
   to save and says why).

Check it: `GET http://127.0.0.1:4320/agent/research/config` →
`{"configured": true, "endpoint": "...", "source": "file" | "environment"}`.

## Running SearXNG yourself (not done by AURA — you decide)

SearXNG must have the JSON format enabled, or it answers **403** to `format=json`.

```bash
mkdir -p ~/searxng && cd ~/searxng
cat > settings.yml <<'YAML'
use_default_settings: true
server:
  secret_key: "change-me-to-a-long-random-string"
  limiter: false          # local, single user
search:
  formats: [html, json]   # json is required by AURA
YAML
docker run -d --name searxng -p 127.0.0.1:8888:8080 \
  -v "$PWD/settings.yml:/etc/searxng/settings.yml:ro" searxng/searxng
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 300   # must show {"results": ...
```

Then use `http://127.0.0.1:8888/search` as the endpoint. Any other SearXNG-compatible gateway works the same way.
Loopback and private addresses are allowed; cloud metadata addresses are not.

## What AURA does with results

* The search is made by AURA (a governed capability), not by the model. The model is told it did not browse.
* Each result keeps its URL, title, snippet and retrieval time. They reach the model fenced as untrusted data,
  numbered `[1]…[n]`.
* Citations in the answer are kept only if they point at a source that exists; `[n]` becomes a link to that URL.
  Sources consulted but not cited are listed separately, labelled as such.
* Empty results, timeouts, 403/429/500, and malformed answers are each reported as what they are; the answer is
  then marked as not web-verified.

# syntax=docker/dockerfile:1.7
# AURA Python environment backend (Starlette + uvicorn) on port 4320.
# Build from the repo root:  docker build -f docker/backend.Dockerfile .

FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
# Extras are off by default; e.g. --build-arg AURA_EXTRAS=multimodal,artifacts
ARG AURA_EXTRAS=""
COPY backend/pyproject.toml backend/pyproject.toml
# Install only the declared dependencies, so source edits don't bust this layer.
RUN python - <<'PY' > /tmp/requirements.txt
import os, tomllib
data = tomllib.load(open("backend/pyproject.toml", "rb"))["project"]
reqs = list(data["dependencies"])
for extra in filter(None, os.environ.get("AURA_EXTRAS", "").split(",")):
    reqs += data["optional-dependencies"][extra.strip()]
print("\n".join(reqs))
PY
RUN pip install --prefix=/install -r /tmp/requirements.txt

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    AURA_HOME=/data \
    AURA_BIND_HOST=0.0.0.0 \
    AURA_OLLAMA_BASE_URL=http://host.docker.internal:11434
COPY --from=deps /install /usr/local
WORKDIR /app
# Same layout as the repo: the entry point finds `backend/` beside `scripts/`.
COPY backend/aura backend/aura
COPY scripts/serve_central_agent_api.py scripts/serve_central_agent_api.py
# uid 1000 matches the `node` user in the AI service image: both share the
# /data volume, just as both share ~/.aura on the desktop.
RUN useradd --create-home --uid 1000 aura \
 && mkdir -p /data && chown aura:aura /data
USER aura
VOLUME ["/data"]
EXPOSE 4320
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4320/health', timeout=4).status == 200 else 1)"
CMD ["python", "scripts/serve_central_agent_api.py", "4320"]

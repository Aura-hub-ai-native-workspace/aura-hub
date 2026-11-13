# syntax=docker/dockerfile:1.7
# AURA Node AI service on port 4319.
# Build from the repo root:  docker build -f docker/ai-service.Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages packages
# esbuild resolves the `@aura/*` subpath imports through the `paths` in the
# root tsconfig that packages/*/tsconfig.json extend.
COPY tsconfig.base.json ./
# Same esbuild call as the root `npm run ai` script. TypeScript stays
# external: diagnosis/* loads the real compiler at runtime.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx esbuild packages/ai-service/src/start.ts --bundle --platform=node \
      --format=esm --external:typescript --outfile=/out/ai-service.mjs \
 && mkdir -p /out/node_modules \
 && cp -r node_modules/typescript /out/node_modules/typescript

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    AI_PORT=4319 \
    AURA_HOME=/data \
    AURA_BIND_HOST=0.0.0.0 \
    AURA_OLLAMA_BASE_URL=http://host.docker.internal:11434
WORKDIR /app
COPY --from=build /out/ ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4319
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4319/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# --none: start without opening a project folder.
CMD ["node", "ai-service.mjs", "--none"]

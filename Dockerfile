FROM node:22-slim AS base
WORKDIR /app

# Pre-install tools for worker sandboxes (bwrap sandbox bind-mounts host root read-only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap curl jq python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/runtime/package.json packages/runtime/
COPY packages/schema/package.json packages/schema/
RUN npm ci --omit=dev

COPY packages/api packages/api
COPY packages/runtime packages/runtime
COPY packages/schema packages/schema

FROM base AS api
EXPOSE 8000
CMD ["npx", "tsx", "packages/api/src/index.ts"]

FROM base AS migrate
CMD ["node", "packages/schema/migrate.js"]

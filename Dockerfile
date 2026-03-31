FROM node:22-slim AS base
WORKDIR /app

# Pre-install tools for worker sandboxes (bwrap sandbox bind-mounts host root read-only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap curl jq python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build CLI in a separate stage (needs dev deps for tsup)
FROM base AS cli-build
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/
RUN npm ci -w packages/cli
COPY packages/cli packages/cli
RUN cd packages/cli && npx tsup --no-dts
# Re-install production-only deps in an isolated directory for the final image
RUN mkdir /cli-standalone \
    && cp packages/cli/package.json /cli-standalone/ \
    && cp -r packages/cli/dist /cli-standalone/dist \
    && cd /cli-standalone && npm install --omit=dev

# Main app stage with production deps + pre-built CLI
FROM base AS app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/runtime/package.json packages/runtime/
COPY packages/schema/package.json packages/schema/
RUN npm ci --omit=dev

COPY packages/api packages/api
COPY packages/runtime packages/runtime
COPY packages/schema packages/schema

# Install pre-built CLI globally for worker sandboxes
COPY --from=cli-build /cli-standalone /usr/local/lib/arke-cli
RUN ln -s /usr/local/lib/arke-cli/dist/index.js /usr/local/bin/arke

FROM app AS api
EXPOSE 8000
CMD ["npx", "tsx", "packages/api/src/index.ts"]

FROM app AS migrate
CMD ["node", "packages/schema/migrate.js"]

FROM node:22-slim AS base
WORKDIR /app

# Pre-install tools for worker sandboxes (bwrap sandbox bind-mounts host root read-only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap curl jq poppler-utils python3 python3-pip ca-certificates \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Build CLI + TS SDK in a separate stage (needs dev deps for tsup)
# CLI codegen imports the API app to generate OpenAPI spec, so we need the full repo.
FROM base AS cli-build
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/api/package.json packages/api/
COPY packages/runtime/package.json packages/runtime/
RUN npm ci -w packages/cli -w packages/sdk-ts -w packages/shared -w packages/api -w packages/runtime
COPY packages/shared packages/shared
COPY packages/cli packages/cli
COPY packages/sdk-ts packages/sdk-ts
COPY packages/api packages/api
COPY packages/runtime packages/runtime
RUN cd packages/sdk-ts && npx tsup
RUN cd packages/cli && npm run fetch-spec && npm run generate && npx tsup --no-dts
# Re-install production-only deps in an isolated directory for the final image.
# The standalone CLI is just dist/index.js + runtime deps. Strip devDependencies
# entirely — npm install --omit=dev still resolves dev deps against the registry,
# and @arkeon-technologies/shared (a private workspace package) would 404.
RUN mkdir /cli-standalone \
    && node -e "const p=require('./packages/cli/package.json'); delete p.devDependencies; require('fs').writeFileSync('/cli-standalone/package.json', JSON.stringify(p,null,2))" \
    && cp -r packages/cli/dist /cli-standalone/dist \
    && cd /cli-standalone && npm install --omit=dev
# SDK has zero runtime deps — just copy the built output
RUN mkdir -p /sdk-standalone \
    && cp packages/sdk-ts/package.json /sdk-standalone/ \
    && cp -r packages/sdk-ts/dist /sdk-standalone/dist

# Build explorer SPA
# Root lockfile references all workspaces, so all sibling package.json files must be present.
FROM node:22-slim AS explorer-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY packages/api/package.json packages/api/
COPY packages/runtime/package.json packages/runtime/
COPY packages/schema/package.json packages/schema/
COPY packages/explorer/package.json packages/explorer/
RUN npm ci -w packages/explorer
COPY packages/explorer packages/explorer
RUN cd packages/explorer && npm run build

# Main app stage with production deps + pre-built CLI
FROM base AS app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/runtime/package.json packages/runtime/
COPY packages/schema/package.json packages/schema/
COPY packages/sdk-ts/package.json packages/sdk-ts/
RUN npm ci --omit=dev

COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/runtime packages/runtime
COPY packages/schema packages/schema

# Copy pre-built SDK into the workspace so the API can import it at runtime.
# Also used by worker sandboxes via the /node_modules symlink below.
COPY --from=cli-build /sdk-standalone/dist packages/sdk-ts/dist

# Copy pre-built explorer SPA
COPY --from=explorer-build /app/packages/explorer/dist packages/explorer/dist

# Install pre-built CLI globally for worker sandboxes
COPY --from=cli-build /cli-standalone /usr/local/lib/arkeon-cli
RUN ln -s /usr/local/lib/arkeon-cli/dist/index.js /usr/local/bin/arkeon

# Expose the SDK at the filesystem root so Node's ESM resolver finds it
# from worker sandboxes. Workers run from /tmp/arke-worker-* and module
# resolution walks up from there — it visits /node_modules but never
# /app/node_modules. The npm-ci-created /app/node_modules/@arkeon-technologies/sdk
# workspace link stays in place for the API server's own imports.
RUN mkdir -p /node_modules/@arkeon-technologies \
    && ln -s /app/packages/sdk-ts /node_modules/@arkeon-technologies/sdk \
    && ln -s /app/packages/sdk-ts /node_modules/arkeon-sdk

# Install common document-processing packages for worker sandboxes
RUN pip install --break-system-packages --no-cache-dir \
    reportlab pypdf python-docx openpyxl python-pptx \
    ebooklib beautifulsoup4 lxml \
    Pillow pandas markdown chardet

FROM app AS api
EXPOSE 8000
CMD ["npx", "tsx", "packages/api/src/index.ts"]

FROM app AS migrate
CMD ["node", "packages/schema/migrate.js"]

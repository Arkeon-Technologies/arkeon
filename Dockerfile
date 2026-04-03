FROM node:22-slim AS base
WORKDIR /app

# Pre-install tools for worker sandboxes (bwrap sandbox bind-mounts host root read-only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap curl jq python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Build CLI + TS SDK in a separate stage (needs dev deps for tsup)
FROM base AS cli-build
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
COPY packages/sdk-ts/package.json packages/sdk-ts/
RUN npm ci -w packages/cli -w packages/sdk-ts -w packages/shared
COPY packages/shared packages/shared
COPY packages/cli packages/cli
COPY packages/sdk-ts packages/sdk-ts
RUN cd packages/cli && npx tsup --no-dts
RUN cd packages/sdk-ts && npx tsup
# Re-install production-only deps in an isolated directory for the final image.
# Remove arkeon-shared from deps — it's already bundled into dist by tsup (noExternal).
RUN mkdir /cli-standalone \
    && node -e "const p=require('./packages/cli/package.json'); delete p.dependencies['arkeon-shared']; require('fs').writeFileSync('/cli-standalone/package.json', JSON.stringify(p,null,2))" \
    && cp -r packages/cli/dist /cli-standalone/dist \
    && cd /cli-standalone && npm install --omit=dev
# SDK has zero runtime deps — just copy the built output
RUN mkdir -p /sdk-standalone \
    && cp packages/sdk-ts/package.json /sdk-standalone/ \
    && cp -r packages/sdk-ts/dist /sdk-standalone/dist

# Main app stage with production deps + pre-built CLI
FROM base AS app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/runtime/package.json packages/runtime/
COPY packages/schema/package.json packages/schema/
RUN npm ci --omit=dev

COPY packages/shared packages/shared
COPY packages/api packages/api
COPY packages/runtime packages/runtime
COPY packages/schema packages/schema

# Install pre-built CLI globally for worker sandboxes
COPY --from=cli-build /cli-standalone /usr/local/lib/arkeon-cli
RUN ln -s /usr/local/lib/arkeon-cli/dist/index.js /usr/local/bin/arkeon

# Install TS SDK globally for worker sandboxes (import * as arke from 'arkeon-sdk')
COPY --from=cli-build /sdk-standalone /usr/local/lib/node_modules/arkeon-sdk

# Install Python SDK for worker sandboxes (import arkeon_sdk as arkeon)
COPY packages/sdk-python /tmp/sdk-python
RUN pip install --break-system-packages --no-cache-dir /tmp/sdk-python \
    && rm -rf /tmp/sdk-python

FROM app AS api
EXPOSE 8000
CMD ["npx", "tsx", "packages/api/src/index.ts"]

FROM app AS migrate
CMD ["node", "packages/schema/migrate.js"]

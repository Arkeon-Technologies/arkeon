FROM node:22-slim AS base
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/schema/package.json packages/schema/
RUN npm ci --omit=dev

COPY packages/api packages/api
COPY packages/schema packages/schema

FROM base AS api
EXPOSE 8000
CMD ["npx", "tsx", "packages/api/src/index.ts"]

FROM base AS migrate
CMD ["node", "packages/schema/migrate.js"]

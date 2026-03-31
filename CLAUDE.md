# arkeon

Monorepo for the Arkeon platform. npm workspaces with four packages:

- `packages/api` — Node.js API server (Hono + Postgres + local/S3 file storage)
- `packages/cli` — CLI auto-generated from the API's OpenAPI spec
- `packages/schema` — Database migration SQL files
- `packages/runtime` — Sandboxed worker/agent runtime

## Quick Start

```bash
# Option A: Local Postgres via Docker
docker compose --profile local-db up -d postgres
npm run migrate
npm run dev -w packages/api

# Option B: External Postgres (Neon, RDS, etc.)
# Set DATABASE_URL in .env
npm run migrate
npm run dev -w packages/api
```

Default `DATABASE_URL` when unset: `postgresql://arke:arke@localhost:5432/arke`

## Workspace Commands

```bash
npm run dev -w packages/api        # Start API dev server (port 8000)
npm run migrate                    # Run schema migrations
npm run build -w packages/cli      # Build CLI
npm run typecheck -w packages/api  # Typecheck API
npm run test:e2e -w packages/api   # Run API e2e tests
```

## Docker

```bash
docker compose up                                    # API only (external DB)
docker compose --profile local-db up                 # API + local Postgres
docker compose --profile local-db --profile migrate up  # Full stack + migrations
```

## Configuration

See `.env.example` for all options. Key settings:
- `DATABASE_URL` — any Postgres connection string (defaults to local)
- `STORAGE_BACKEND` — `local` (default) or `s3` (R2, S3, MinIO)
- `PORT` — server port (default 8000)

## API: LLM Help System

The API has a layered, self-documenting help system served at `/llms.txt` and `/help`. It is the primary way LLMs discover and understand the API.

**When adding, modifying, or removing routes, you MUST update the route's `createRoute()` definition and Zod schemas.** OpenAPI is generated at runtime from the route definitions and powers all of:
- `/openapi.json`
- `/llms.txt`
- `/help/:method/:path`

Checklist for route changes:
- Define or update the route with `createRoute()` in the route file
- Reuse shared schemas from `packages/api/src/lib/schemas.ts` when possible
- Include `operationId`, `tags`, `summary`, `x-arke-auth`, and `x-arke-related`
- Use OpenAPI path params like `/{id}` in route metadata
- Keep summaries concise; put detail in parameter descriptions and schema descriptions
- Make request and response schemas accurate enough for CLI codegen and `/help` rendering

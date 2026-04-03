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
./scripts/test-sandbox.sh          # Test bwrap sandbox in Docker (required for sandbox/worker-invoke changes)
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

## Documentation Principles

Docs in `docs/` are for information that is **not derivable from reading the code**:
- **Why**: Design rationale, trade-offs, architectural decisions
- **How things interact**: Cross-cutting behavior spanning multiple packages/services
- **Conventions**: Client-side patterns not enforced by code (e.g., entity refs, `arke:` URIs)
- **Operational knowledge**: Failure modes, gotchas, recommended usage patterns

Docs should **never** contain: endpoint lists, schema definitions, config defaults, or command references that live in code, `package.json`, or `.env.example`. Use `/openapi.json`, `/help`, or read the source.

### Updating docs after feature work

After changes that rename concepts, remove/replace features, add features previously marked "future", or change how packages interact:

1. Run `/review-docs all` or `/review-docs <filename>` to compare docs against codebase
2. Delete docs about removed features
3. Move "future" docs to `docs/` when the feature ships
4. Trim any section that just restates what the code already says
5. Update terminology, file paths, and column names to match current code
6. Grep remaining docs for stale references (`git grep` old table names, endpoints, etc.)

Pay special attention to changes that span multiple services (e.g., renaming "commons" to "spaces" touched schema, routes, and 8 docs). These are the hardest to discover later.

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

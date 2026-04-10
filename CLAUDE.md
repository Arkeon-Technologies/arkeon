# arkeon

Monorepo for the Arkeon platform. npm workspaces with four packages:

- `packages/api` — Node.js API server (Hono + Postgres + local/S3 file storage)
- `packages/cli` — CLI auto-generated from the API's OpenAPI spec
- `packages/schema` — Database migration SQL files
- `packages/runtime` — Sandboxed worker/agent runtime

## Quick Start

```bash
# 1. Copy the env template and fill in the required secrets
cp .env.example .env
# edit .env: ADMIN_BOOTSTRAP_KEY, ENCRYPTION_KEY, MEILI_MASTER_KEY, POSTGRES_PASSWORD

# Option A: Full stack via Docker (api + postgres + meilisearch + redis + migrate)
docker compose up

# Option B: Host API against an existing Postgres
# Set DATABASE_URL in .env to your external instance
npm run migrate
npm run dev -w packages/api
```

See `.env.example` for the full list of environment variables. The API
and compose stack will refuse to boot if any required secret is missing.

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
docker compose up            # full stack: api + postgres + meilisearch + redis + migrate
docker compose down -v       # tear down and drop volumes
```

Migrations run automatically on every `docker compose up` via the
`migrate` service, which the `api` service blocks on.

## Configuration

See `.env.example` for all options. Required secrets (no defaults):
- `ADMIN_BOOTSTRAP_KEY` — seeds the first admin API key
- `ENCRYPTION_KEY` — 64-char hex (AES-256-GCM for secrets at rest)
- `MEILI_MASTER_KEY` — Meilisearch master key
- `POSTGRES_PASSWORD` — local compose Postgres password

Optional features:
- `ENABLE_KNOWLEDGE_PIPELINE=true` — opt in to the LLM knowledge
  extraction pipeline (off by default; see `docs/ADVANCED.md`)
- `STORAGE_BACKEND=s3` — switch from local filesystem to S3/R2/MinIO

## Do NOT add in-process rate limiting

We deliberately have no rate limiter. Do not propose adding a per-IP
token bucket, a path exemption list, or a middleware to throttle
requests. The tradeoffs are captured in `docs/ADVANCED.md` under
"Rate limiting (not implemented)" — read that before suggesting
otherwise. Rate limiting, when we need it, belongs at the edge
(Cloudflare / nginx in front of deployed instances) or as per-actor
database quotas, not in-process.

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
- Include `operationId`, `tags`, `summary`, `x-arke-auth`, `x-arke-related`, and `x-arke-rules`
- `x-arke-rules` is an array of strings describing permission/authorization rules for the route
  - Write from the caller's perspective ("Requires...", "Only...", "Cannot...")
  - Cover both app-layer checks and RLS-layer enforcement
  - Do not duplicate info already in `x-arke-auth` (e.g. don't say "authentication required")
  - Use empty array `[]` for routes with no authorization rules beyond basic auth
- Use OpenAPI path params like `/{id}` in route metadata
- Keep summaries concise; put detail in parameter descriptions and schema descriptions
- Make request and response schemas accurate enough for CLI codegen and `/help` rendering

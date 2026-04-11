# arkeon

Monorepo for the Arkeon platform. npm workspaces with:

- `packages/api` — Node.js API server (Hono + Postgres + local/S3 file storage)
- `packages/cli` — CLI (`arkeon`) — auto-generated from the API's OpenAPI spec, plus the hand-written local-mode commands (`start`/`stop`/`status`/`migrate`/`reset`)
- `packages/schema` — Database migration SQL files
- `packages/runtime` — Sandboxed worker/agent runtime
- `packages/sdk-ts` — TypeScript SDK
- `packages/shared`, `packages/explorer` — supporting libraries

## Quick Start

Arkeon runs as a single Node process that manages its own Postgres and Meilisearch. No Docker, no system services.

```bash
npm install
npm run build -w packages/sdk-ts              # prebuilt SDK is required
npx tsx packages/cli/src/index.ts start       # bring up the full stack
```

First run downloads a Meilisearch binary into `~/.arkeon/bin/` (one-time, ~100MB), initializes an embedded Postgres cluster in `~/.arkeon/data/postgres/`, runs migrations, and starts the API on `http://localhost:8000`. The admin API key is generated on first start and printed to the console (and persisted in `~/.arkeon/secrets.json` for subsequent starts).

`Ctrl+C` drains gracefully. From another terminal: `arkeon status`, `arkeon stop`, `arkeon reset`.

State lives in `~/.arkeon/` by default (override with `ARKEON_HOME`). `arkeon reset` wipes data but keeps secrets + binary; `arkeon reset --hard` wipes everything.

## Workspace Commands

```bash
npx tsx packages/cli/src/index.ts start   # Start the full local stack
npx tsx packages/cli/src/index.ts stop    # Stop it
npx tsx packages/cli/src/index.ts migrate # Run migrations without starting API
npm run typecheck -w packages/api         # Typecheck API
npm run test:e2e -w packages/api          # Run API e2e tests (needs a running stack)
./scripts/test-local.sh                   # Full pre-push check: typecheck + start + e2e
./scripts/test-sandbox.sh                 # Worker sandbox tests (requires bubblewrap on Linux)
```

## Configuration

Local-mode defaults are fine out of the box — secrets are generated on first run. For advanced setups see `.env.example` for host-mode overrides:
- `DATABASE_URL` — point at an external Postgres instead of embedded
- `MEILI_URL` / `MEILI_MASTER_KEY` — point at an external Meilisearch
- `ENABLE_KNOWLEDGE_PIPELINE=true` — opt in to the LLM knowledge extraction pipeline (requires `OPENAI_API_KEY`; see `docs/ADVANCED.md`)
- `STORAGE_BACKEND=s3` — switch from local filesystem to S3/R2/MinIO
- `ARKEON_HOME` — override the `~/.arkeon` state directory

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

## Schema Migrations

Migrations in `packages/schema/` run on every deploy — there is no migration state tracker, so **every migration must be idempotent**. A migration that worked once will run again on the next deploy and must not fail.

Rules:
- `CREATE TABLE` / `CREATE INDEX` — always use `IF NOT EXISTS`
- `INSERT` seed data — always use `ON CONFLICT ... DO NOTHING` (or `DO UPDATE` if the seed should evolve)
- `ALTER TABLE ADD COLUMN` — wrap in a `DO $$ ... IF NOT EXISTS` check, or use `ADD COLUMN IF NOT EXISTS` (PG 9.6+)
- `ALTER TABLE DROP COLUMN` / `DROP CONSTRAINT` — always use `IF EXISTS`
- `DROP TABLE` / `DROP INDEX` — always use `IF EXISTS`
- Never assume a previous migration's intermediate state still exists (e.g., a constraint created in migration N may already be dropped by migration N+3)
- Test migrations by running `arkeon migrate` twice in a row — the second run must succeed cleanly
- Do not use loadable extensions (`CREATE EXTENSION`). The local stack uses embedded Postgres which does not ship extensions beyond what's built-in. Retention jobs that used to live in `pg_cron` now run in-process via `packages/api/src/lib/retention.ts` — follow that pattern for new periodic tasks.

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

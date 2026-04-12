# arkeon

Three npm workspaces. Only two are published to npm.

- `packages/arkeon` — the main package, published as `arkeon` on npm. Contains the CLI binary, the Hono API server, the sandboxed worker runtime, the database schema migrations, and shared TypeScript types. Single source tree under `src/`:
  - `src/index.ts` — CLI entry (commander wiring)
  - `src/cli/commands/**` + `src/cli/lib/**` — CLI commands and helpers
  - `src/server/**` — Hono API server (routes, middleware, knowledge pipeline)
  - `src/runtime/**` — sandboxed agent runtime (formerly `packages/runtime`)
  - `src/schema/*.sql` + `src/schema/migrate.ts` — migrations and the in-process runner
  - `src/shared/**` — concept text and OpenAPI helpers shared between CLI codegen and the server
  - `src/generated/**` — checked-in codegen outputs (OpenAPI snapshot → CLI commands + bundled Genesis seed)
- `packages/sdk-ts` — published as `@arkeon-technologies/sdk`, a lightweight HTTP client for the API. Separate because external consumers want the client without the full server.
- `packages/explorer` — browser SPA built with Vite, not published. Built as part of the `arkeon` build (via `bundle-explorer`); the static output is copied into `packages/arkeon/dist/explorer/` so it ships inside the `arkeon` tarball.

## Quick Start

Arkeon runs as a single Node process that manages its own Postgres and Meilisearch. No Docker, no system services.

```bash
npm install
npm run build -w packages/sdk-ts              # prebuilt SDK is required
npx tsx packages/arkeon/src/index.ts start    # bring up the full stack
```

First run downloads a Meilisearch binary into `~/.arkeon/bin/` (one-time, ~100MB), initializes an embedded Postgres cluster in `~/.arkeon/data/postgres/`, runs migrations in-process, and starts the API on `http://localhost:8000`. The admin API key is generated on first start and printed to the console (and persisted in `~/.arkeon/secrets.json` for subsequent starts).

`Ctrl+C` drains gracefully. From another terminal: `arkeon status`, `arkeon stop`, `arkeon reset`.

State lives in `~/.arkeon/` by default (override with `ARKEON_HOME`). `arkeon reset` wipes data but keeps secrets + binary; `arkeon reset --hard` wipes everything.

## Workspace Commands

```bash
npx tsx packages/arkeon/src/index.ts start   # Start the full local stack
npx tsx packages/arkeon/src/index.ts stop    # Stop it
npx tsx packages/arkeon/src/index.ts migrate # Run migrations without starting the API
npm run typecheck -w packages/arkeon         # Typecheck everything in one shot
npm test -w packages/arkeon                  # Unit tests (test/unit/**)
npm run test:e2e -w packages/arkeon          # API e2e tests (needs a running stack)
./scripts/test-local.sh                      # Full pre-push check: typecheck + unit + start + e2e
./scripts/test-sandbox.sh                    # Worker sandbox tests (requires bubblewrap on Linux)
```

## Configuration

Local-mode defaults are fine out of the box — secrets are generated on first run. For advanced setups see `.env.example` for host-mode overrides:
- `DATABASE_URL` — point at an external Postgres instead of embedded
- `MEILI_URL` / `MEILI_MASTER_KEY` — point at an external Meilisearch
- `ENABLE_KNOWLEDGE_PIPELINE=true` — opt in to the LLM knowledge extraction pipeline (requires `OPENAI_API_KEY`; see `docs/ADVANCED.md`)
- `STORAGE_BACKEND=s3` — switch from local filesystem to S3/R2/MinIO
- `ARKEON_HOME` — override the `~/.arkeon` state directory

## One package, one deps list

All of arkeon's server, CLI, runtime, schema, and shared code lives in `packages/arkeon/` as a single published package. There is no splitting between them — adding a dep means one line in `packages/arkeon/package.json`, nothing else. The deps on `@arkeon-technologies/{api,runtime,schema,shared}` are gone; those subtrees are regular `src/` directories now.

If you ever find yourself tempted to split a subtree out as its own published package, check first:
1. Does it have a genuinely external consumer (not just "we import it elsewhere in the monorepo")?
2. Does it need an independent release cadence?
3. Does it have a different runtime target (browser/Deno/etc.)?

If none apply, keep it under `packages/arkeon/src/`. The CLI/server split we had in 0.3.0 and 0.3.1 caused cascading packaging bugs (tsup followed the workspace symlink, bundled the entire server tree with transitive deps, and tripped CJS/ESM interop errors) and was reverted for exactly this reason.

## Do NOT bundle server code into the CLI

`packages/arkeon/tsup.config.ts` uses all defaults — no `noExternal`, no explicit `external` list. Tsup auto-externalizes everything in `package.json` `dependencies` and bundles the `src/` tree via relative imports. Do not override this.

Specifically: if you see the `arkeon` dist size balloon above ~3MB, or see AWS SDK chunks (`sso-oidc-*.js`) inlined in the output instead of as `import` references, something is mis-configured. The fix is almost always to remove a `noExternal` entry or to put a dep in `dependencies` where tsup can see it.

A healthy build produces:
- `dist/index.js` — ~200 KB CLI entry
- `dist/server-*.js` — ~500 KB lazy-loaded server chunk (split via dynamic import)
- `dist/chunk-*.js` — ~15 KB shared chunk
- `dist/explorer/` — ~500 KB Vite SPA
- `dist/schema/*.sql` — ~200 KB, all 38 migration files
- Total: ~2.5-3 MB

## Fresh-install smoke testing

Before every release, manually verify the published tarball in a clean scratch directory. CI does NOT test this path — CI uses the monorepo dev flow via `tsx`, which never exercises a real `npm install`. Packaging bugs only surface in a real install cycle, which is how 0.3.0 and 0.3.1 shipped broken.

```bash
cd packages/arkeon && npm pack
cd /tmp && mkdir smoke && cd smoke
npm init -y
npm install /path/to/arkeon-<version>.tgz
ARKEON_HOME=./state npx arkeon init
ARKEON_HOME=./state npx arkeon up
ARKEON_HOME=./state npx arkeon seed
ARKEON_HOME=./state npx arkeon status
curl http://localhost:8000/health
curl http://localhost:8000/explore
ARKEON_HOME=./state npx arkeon down
```

Do not skip this step.

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

Migrations in `packages/arkeon/src/schema/` run on every deploy — there is no migration state tracker, so **every migration must be idempotent**. A migration that worked once will run again on the next deploy and must not fail.

Rules:
- `CREATE TABLE` / `CREATE INDEX` — always use `IF NOT EXISTS`
- `INSERT` seed data — always use `ON CONFLICT ... DO NOTHING` (or `DO UPDATE` if the seed should evolve)
- `ALTER TABLE ADD COLUMN` — wrap in a `DO $$ ... IF NOT EXISTS` check, or use `ADD COLUMN IF NOT EXISTS` (PG 9.6+)
- `ALTER TABLE DROP COLUMN` / `DROP CONSTRAINT` — always use `IF EXISTS`
- `DROP TABLE` / `DROP INDEX` — always use `IF EXISTS`
- Never assume a previous migration's intermediate state still exists (e.g., a constraint created in migration N may already be dropped by migration N+3)
- Test migrations by running `arkeon migrate` twice in a row — the second run must succeed cleanly
- Do not use loadable extensions (`CREATE EXTENSION`). The local stack uses embedded Postgres which does not ship extensions beyond what's built-in. Retention jobs that used to live in `pg_cron` now run in-process via `packages/arkeon/src/server/lib/retention.ts` — follow that pattern for new periodic tasks.

The migration runner itself lives at `packages/arkeon/src/schema/migrate.ts`. It exports `runMigrations({ databaseUrl, arkeAppPassword })` and is imported directly by `arkeon start` — no child process, no spawn, no top-level-await script.

## API: LLM Help System

The API has a layered, self-documenting help system served at `/llms.txt` and `/help`. It is the primary way LLMs discover and understand the API.

**When adding, modifying, or removing routes, you MUST update the route's `createRoute()` definition and Zod schemas.** OpenAPI is generated at runtime from the route definitions and powers all of:
- `/openapi.json`
- `/llms.txt`
- `/help/:method/:path`

Checklist for route changes:
- Define or update the route with `createRoute()` in the route file
- Reuse shared schemas from `packages/arkeon/src/server/lib/schemas.ts` when possible
- Include `operationId`, `tags`, `summary`, `x-arke-auth`, `x-arke-related`, and `x-arke-rules`
- `x-arke-rules` is an array of strings describing permission/authorization rules for the route
  - Write from the caller's perspective ("Requires...", "Only...", "Cannot...")
  - Cover both app-layer checks and RLS-layer enforcement
  - Do not duplicate info already in `x-arke-auth` (e.g. don't say "authentication required")
  - Use empty array `[]` for routes with no authorization rules beyond basic auth
- Use OpenAPI path params like `/{id}` in route metadata
- Keep summaries concise; put detail in parameter descriptions and schema descriptions
- Make request and response schemas accurate enough for CLI codegen and `/help` rendering

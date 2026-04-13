# Architecture

High-level map of the Arkeon codebase for contributors.

## Packages

```
packages/
  arkeon/       Main package (published as `arkeon` on npm)
                CLI, API server, runtime, schema, shared types
  sdk-ts/       TypeScript SDK (published as `@arkeon-technologies/sdk`)
                Lightweight HTTP client, zero dependencies
  explorer/     Browser SPA (private, not published)
                Vite + React + Tailwind, built into arkeon dist
```

Everything ships inside the `arkeon` npm tarball. The SDK is the only
separately published package — it exists because external consumers
want the HTTP client without the full server.

## Source layout (`packages/arkeon/src/`)

```
src/
  index.ts                CLI entry (commander wiring)
  cli/
    commands/             CLI command definitions
    lib/                  CLI helpers (auth, config, output)
  server/
    app.ts                Hono app factory, route mounting
    server.ts             Startup sequence, graceful shutdown
    routes/               Route handlers by domain
    middleware/            Auth, request context
    lib/                  Shared server utilities, schemas
    knowledge/            Knowledge extraction pipeline
  runtime/                Sandboxed worker execution
  schema/
    *.sql                 Numbered migrations (001–038)
    migrate.ts            In-process migration runner
  shared/                 Concepts + OpenAPI helpers shared between
                          CLI codegen and server
  generated/              Checked-in codegen outputs
                          (OpenAPI snapshot, CLI commands, bundled assets)
```

## Request lifecycle

```
HTTP request
  → Hono router
  → requestContextMiddleware (assigns request ID)
  → authMiddleware (validates API key, sets actor session vars)
  → route handler (Zod validation via @hono/zod-openapi)
  → Postgres (via node-postgres, with RLS enforced per-session)
  → JSON response
```

Meilisearch is called for `/search` endpoints. S3 (or local filesystem)
is called for file uploads/downloads.

## Build pipeline

The build has several stages, all wired through `package.json` scripts:

1. **fetch-spec** — imports `app.ts` directly (no running server) and
   writes the OpenAPI snapshot to `spec/openapi.snapshot.json`
2. **generate** — reads the snapshot and generates CLI commands into
   `src/generated/`
3. **bundle-assets** — embeds the Genesis seed data into
   `src/generated/assets.ts`
4. **tsup** — compiles `src/` to ESM (`dist/`). Auto-externalizes
   everything in `package.json` `dependencies`
5. **bundle-explorer** — builds the React SPA and copies output to
   `dist/explorer/`
6. **bundle-schema** — copies `src/schema/*.sql` to `dist/schema/`

**Healthy build output** (~2.5–3 MB total):
- `dist/index.js` — ~200 KB CLI entry
- `dist/server-*.js` — ~500 KB lazy-loaded server chunk
- `dist/explorer/` — ~500 KB Vite SPA
- `dist/schema/*.sql` — migration files

If dist balloons past ~3 MB or you see AWS SDK chunks inlined, something
is misconfigured — check `tsup.config.ts` for stray `noExternal` entries.

## Startup sequence

`arkeon start` / `arkeon up` runs this in order:

1. Read and normalize env vars (`ARKEON_*` canonical, legacy fallbacks)
2. Create Hono app, generate OpenAPI spec
3. **ensureBootstrap()** — run migrations, seed admin actor
4. **initQueue()** — start worker invocation queue processor
5. **ensureMeiliIndex()** — validate Meilisearch connection (if configured)
6. **serve()** — bind HTTP on port 8000 (configurable)
7. **startScheduler()** — background cron (periodic maintenance)
8. **startRetention()** — retention policy enforcement
9. *(Optional)* Knowledge pipeline — poller + job queue (if enabled)

Graceful shutdown drains in-flight work with a configurable timeout
(`DRAIN_TIMEOUT_MS`, default 320s), then force-exits.

## Key invariants

- **Do not bundle server code into the CLI.** Tsup uses all defaults —
  no `noExternal`, no explicit `external` list. See `CLAUDE.md` for details.
- **Migrations are idempotent.** Every migration runs on every deploy.
  Always use `IF NOT EXISTS` / `IF EXISTS`. See [SCHEMA.md](SCHEMA.md).
- **No in-process rate limiting.** By design — see `docs/ADVANCED.md`.
- **Single package, single deps list.** Do not split subtrees into
  separate published packages unless there is a genuine external consumer
  with an independent release cadence.

## Explorer

The explorer is a React SPA built with Vite, served at `/explore`.
In local mode, the server auto-injects the admin API key into the HTML
so the explorer works without manual auth. In production, the key is
not injected.

## Self-documenting API

The API generates its own documentation from route definitions:
- `/openapi.json` — OpenAPI 3.1 spec
- `/llms.txt` — full reference optimized for LLM context windows
- `/help` — interactive discovery

See [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md) for the full design.

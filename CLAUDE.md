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

## Knowledge Pipeline

The knowledge pipeline (`src/server/knowledge/`) extracts entities and relationships from ingested documents using LLMs. It is **opt-in** via `ENABLE_KNOWLEDGE_PIPELINE=true` + `OPENAI_API_KEY`.

### Pipeline stages

1. **Ingest** — document is chunked; scout identifies existing entities relevant to each chunk
2. **Extract** — LLM extracts entities, relationships, and observations from each chunk (produces an `ExtractPlan`)
3. **Merge** — `mergeGroupPlans()` deduplicates entities across chunks by label+type, resolves cross-chunk refs via suffix fallback, and preserves ULID refs (scouted existing entities) without namespacing
4. **Materialize** — `materializeShellEntities()` promotes inline shell refs (e.g. `target_shell: { label, type }`) to explicit entities
5. **Write** — `buildOpsFromPlan()` converts the merged plan into database ops; ULID refs in `knownEntityIds` are treated as existing entities (bare ID), all others get `@local` prefix
6. **Finalize** — atomic gate claims finalization when all sibling chunk jobs complete, collects scouted entity IDs from job metadata, runs merge→materialize→write

### Testing the pipeline

- **Unit tests** (no LLM, no running stack): `npm test -w packages/arkeon` — covers merge, materialize, and ops-building logic
- **E2E tests** (LLM required): gated behind `ENABLE_KNOWLEDGE_PIPELINE=true` — `chunk-finalization.test.ts`, `ingest-idempotency.test.ts`

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

## CI Checks

Every push to `main` and every PR triggers these checks. **All must pass before merging.** Do not assume a run passed — verify with `gh pr checks <number>` or `gh run list`.

### Workflows

| Workflow | Jobs | What it checks |
|---|---|---|
| **Test and Check CLI Drift** (`build-push.yml`) | `test-and-push` | Typecheck, unit tests, e2e tests against a live stack (port 8000) |
| | `check-cli-spec-drift` | OpenAPI snapshot and generated CLI commands are up to date |
| | `smoke-pack` | `npm pack` → install in clean dir → full lifecycle (up, seed, entities, down) on port 19000 |
| **License Headers** (`license-headers.yml`) | `check` | Every `.ts`/`.js` file has an SPDX header |
| **Publish** (`publish.yml`) | `publish` | Triggered only by `arkeon-v*` / `sdk-v*` GitHub releases |

### How to verify CI

```bash
gh pr checks 81                          # Check status of all jobs on a PR
gh run list --limit 5                    # Recent runs across all workflows
gh run view <run-id> --log               # Full logs for a run
gh api repos/Arkeon-Technologies/arkeon/actions/jobs/<job-id>/logs  # Logs for a specific job
```

When watching CI after a push or release:
1. Wait for **all jobs** to reach a terminal state (not just the first one that finishes)
2. `smoke-pack` and `test-and-push` run in parallel — one can pass while the other fails
3. If `smoke-pack` fails, check the admin key extraction and Phase 7 CLI tests first — these are the most fragile part (they parse `secrets.json` and log output)
4. If `check-cli-spec-drift` fails, rebuild: `npm run build -w packages/sdk-ts && npm run build -w packages/arkeon` and commit the updated generated files

### Common CI gotchas

- **`set -euo pipefail` in shell scripts**: Any command returning non-zero (including `grep` with no match) kills the script. Always use `|| true` for grep commands that might not match.
- **Pretty-printed JSON**: `secrets.json` uses `JSON.stringify(secrets, null, 2)` — grep patterns must allow optional whitespace after colons.
- **`arkeon start` vs `arkeon up`**: `start` prints the admin key to stdout; `up` (daemonized) does not. Scripts extracting the key from logs must account for which command was used.

## Fresh-install smoke testing

CI now runs `scripts/smoke-pack.sh` on every push (the `smoke-pack` job), which packs, installs, and runs the full lifecycle in a clean scratch directory. For manual verification before a release:

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

## Lockfile hygiene after structural changes

If you add, remove, or restructure workspace packages, or change version specifiers in any `package.json`, always regenerate the lockfile from a clean state:

```bash
rm -rf node_modules packages/*/node_modules package-lock.json
npm install
```

Do NOT run `npm install` on top of an existing `node_modules` — npm will preserve the old hoist layout in the lockfile even when the new package.json would resolve differently. A stale lockfile can cause CI to place deps per-package instead of hoisted-to-root, breaking builds that depend on cross-workspace resolution (e.g., the SDK's `tsc --emitDeclarationOnly` step needs `typescript` hoisted to root where tsup can find it).

## Do NOT add in-process rate limiting

We deliberately have no rate limiter. Do not propose adding a per-IP
token bucket, a path exemption list, or a middleware to throttle
requests. The tradeoffs are captured in `docs/ADVANCED.md` under
"Rate limiting (not implemented)" — read that before suggesting
otherwise. Rate limiting, when we need it, belongs at the edge
(Cloudflare / nginx in front of deployed instances) or as per-actor
database quotas, not in-process.

## Documentation Principles

Docs are organized into `docs/user/` (for people running Arkeon),
`docs/dev/` (for contributors and API consumers), `docs/ADVANCED.md`
(in-development features), and `docs/future/` (planned features).

All docs are for information that is **not derivable from reading the code**:
- **Why**: Design rationale, trade-offs, architectural decisions
- **How things interact**: Cross-cutting behavior spanning multiple packages/services
- **Conventions**: Client-side patterns not enforced by code (e.g., entity refs, `arke:` URIs)
- **Operational knowledge**: Failure modes, gotchas, recommended usage patterns

Docs should **never** contain: endpoint lists, schema definitions, config defaults, or command references that live in code, `package.json`, or `.env.example`. Use `/openapi.json`, `/help`, or read the source.

### Updating docs after feature work

After changes that rename concepts, remove/replace features, add features previously marked "future", or change how packages interact:

1. Run `/review-docs all` or `/review-docs <filename>` to compare docs against codebase
2. Delete docs about removed features
3. Move "future" docs to `docs/user/` or `docs/dev/` when the feature ships
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

## Agent Experience (AX) Surfaces

Arkeon has multiple self-documenting surfaces that agents and users rely on to discover and use the API. Every feature an agent might use **must be discoverable** via at least one of: `/llms.txt`, `arkeon docs`, the worker system prompt, or a skill body. If you ship a feature and no AX surface knows about it, it doesn't exist to agents.

Full architecture and data flow: `docs/dev/CONTEXT_MANAGEMENT.md`.

### Quick surface map

| What changed | AX surfaces affected | Action needed |
|---|---|---|
| **Route added/modified/removed** | `/llms.txt`, `/help`, `/openapi.json`, CLI commands, worker prompt, `arkeon docs` | Update `createRoute()` + Zod schemas, then rebuild (see checklist below) |
| **Concept changed** (core definitions, classification, best practices) | API guide, CLI guide, worker prompt | Edit `src/shared/concepts.ts` — propagates automatically |
| **Skill changed** (ingest, connect, doctor protocols) | Claude Code skills | Edit `assets/skills/meta.yaml` or `body/*.md`, rebuild to regenerate `src/generated/assets.ts` |
| **SDK examples or response patterns** | Worker prompt, `/llms.txt` | Edit `worker-prompt.ts` and/or `openapi-help.ts`, then rebuild |
| **Guide content** (getting-started, admin) | `/help/guide`, `arkeon guide` | Edit `help.ts` (API) or `guide/index.ts` (CLI) |
| **Explorer** | `/explore` browser SPA | Edit `packages/explorer/`, rebuild |

### Checklist for route changes

**When adding, modifying, or removing routes, you MUST update the route's `createRoute()` definition and Zod schemas.** OpenAPI is generated at runtime from the route definitions and powers all of:
- `/openapi.json`
- `/llms.txt`
- `/help/:method/:path`
- `arkeon docs --format api`
- Worker system prompt (CLI reference)
- Auto-generated CLI commands

Steps:
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
- **Regenerate CLI commands**: after any route change, run `npm run build -w packages/sdk-ts && npm run build -w packages/arkeon` and commit the updated `spec/openapi.snapshot.json`, `src/generated/index.ts`, and `src/generated/assets.ts`. This works offline — `fetch-spec` imports `app.ts` directly, no running server needed. CI (`check-cli-spec-drift`) will fail if these files are stale.

### AX review habit

After any feature work, ask: "Can an agent discover and use this?" Specifically:
1. If it's an API operation — is it in the OpenAPI spec with good descriptions and `x-arke-rules`?
2. If it's a workflow — is it in a skill body or guide?
3. If it's a concept — is it in `concepts.ts`?
4. If it's a CLI-only feature — does `arkeon docs --format cli` show it?
5. Rebuild and verify: `npm run build -w packages/sdk-ts && npm run build -w packages/arkeon`

## Publishing to npm

Publishing is automated via GitHub Actions (`.github/workflows/publish.yml`) and triggered by **GitHub Releases with specific tag prefixes**:

- `arkeon-v<version>` → publishes `arkeon` to npm (e.g., `arkeon-v0.3.6`)
- `sdk-v<version>` → publishes `@arkeon-technologies/sdk` to npm (e.g., `sdk-v0.1.11`)

Tags like `v0.3.6` (without the `arkeon-` prefix) will NOT trigger a publish. The workflow uses npm trusted publishing (OIDC) — no token needed.

### Release checklist

1. Bump `version` in `packages/arkeon/package.json` (or `packages/sdk-ts/package.json` for SDK)
2. Commit and push to main
3. **Wait for CI to pass** — run `gh run list --limit 3` and confirm all jobs in `Test and Check CLI Drift` (test-and-push, check-cli-spec-drift, smoke-pack) are green. Do not proceed until every job shows `completed success`.
4. Create a GitHub release with the correct tag prefix:
   ```bash
   gh release create arkeon-v0.3.6 --title "arkeon v0.3.6" --generate-notes
   ```
5. **Wait for the Publish workflow** — `gh run list --limit 1` should show `Publish` with `completed success`
6. Verify on npm: `npm view arkeon version`

Do NOT create releases with bare `v*` tags — they won't publish.

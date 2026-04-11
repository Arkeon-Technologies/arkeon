---
name: local-dev
description: Start the local development environment (Postgres + API with hot reload) and run e2e tests.
disable-model-invocation: true
argument-hint: [start|start:docker|test|test:sandbox|reset|stop|status]
allowed-tools: Bash(docker *, npm *, curl *, pkill *, sleep *, kill *, lsof *, ls *, cat *), Read, TaskOutput
---

# Local Development Environment

Manage the local dev stack. Two modes:

- **Local API** (`start`): Dockerized Postgres + local API via `npm run dev`. Best for API route development — instant hot reload on code changes.
- **Full Docker** (`start:docker`): Everything in Docker including the API. Required for **worker/sandbox testing** — provides bwrap isolation, pre-installed CLI/SDKs, document processing packages, and `view_image` support. Use `docker compose --watch` for hot reload.

**When to use which:**
- Editing routes, schemas, middleware → `start` (faster iteration)
- Testing worker invocations, sandbox behavior, CLI/SDK availability → `start:docker` (production-equivalent sandbox)
- Running e2e API tests → `start` + `test`
- Running sandbox integration tests → `test:sandbox`

## Worktree Detection

Before running any command, detect whether you're in a worktree:

1. Check if the current working directory contains `.claude/worktrees/` in its path.
2. If NOT in a worktree, use defaults: `PG_PORT=5432`, `API_PORT=8000`, `PROJECT=arkeon`.
3. If in a worktree, extract the worktree name (e.g., `issue-42` from `.claude/worktrees/issue-42/`).
4. Check if a `.devports` file exists in the worktree root. If yes, read ports from it.
5. If no `.devports` file, pick a random slot (1-99) and verify the ports are free:
   ```bash
   SLOT=$((RANDOM % 99 + 1))
   PG_PORT=$((5432 + SLOT))
   API_PORT=$((8000 + SLOT))
   # Check both ports are free, re-roll if not
   while lsof -iTCP:$PG_PORT -sTCP:LISTEN >/dev/null 2>&1 || \
         lsof -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1; do
     SLOT=$((RANDOM % 99 + 1))
     PG_PORT=$((5432 + SLOT))
     API_PORT=$((8000 + SLOT))
   done
   ```
6. Save the ports to `.devports` in the worktree root so subsequent commands reuse them:
   ```bash
   cat > .claude/worktrees/<name>/.devports <<EOF
   PG_PORT=$PG_PORT
   API_PORT=$API_PORT
   PROJECT=arkeon-<worktree-name>
   EOF
   ```
7. Set `PROJECT=arkeon-<worktree-name>` (e.g., `arkeon-issue-42`).

The `.devports` file is gitignored and ensures `start`, `test`, `stop`, and `reset` all use the same ports for a given worktree.

## .env File

After determining ports, **always write a `.env` file** in the project root (or worktree root) so that `npm run dev` and `npm run test:e2e` pick up config automatically via `dotenv/config`. This eliminates the need to pass env vars inline.

```bash
cat > .env <<EOF
PORT=$API_PORT
PG_PORT=$PG_PORT
DATABASE_URL=postgresql://arke_app:arke@localhost:$PG_PORT/arke
MIGRATION_DATABASE_URL=postgresql://arke:arke@localhost:$PG_PORT/arke
ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
MEILI_MASTER_KEY=dev_meili_key
POSTGRES_PASSWORD=arke
E2E_BASE_URL=http://localhost:$API_PORT
EOF
```

This file is gitignored. Write it on every `start` and `reset` to keep it in sync with the assigned ports. The weak dev-only secrets above are safe here because the `.devports` setup binds ports to localhost and worktrees are ephemeral — never reuse them outside local dev.

## Commands

`$ARGUMENTS` determines the action:

### `start` (default if no argument)

1. Write the `.env` file (see above).

2. Check if Postgres is already running:
   ```
   docker compose -p $PROJECT ps postgres
   ```

3. If not running, start Postgres and run migrations:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT up -d postgres migrate
   ```
   Wait for migrate to exit successfully:
   ```
   docker compose -p $PROJECT logs -f migrate
   ```

4. Check if the API is already running on the target port:
   ```
   curl -s http://localhost:$API_PORT/ 2>/dev/null
   ```

5. If not running, start the API locally with hot reload:
   ```
   npm run dev -w packages/api
   ```
   Run this in the background. Wait a few seconds, then verify with:
   ```
   curl -s http://localhost:$API_PORT/
   ```
   Should return `{"name":"arkeon-api","status":"ok"}`.

6. Confirm to the user that the stack is up:
   - Postgres on port `$PG_PORT`
   - API on port `$API_PORT` with hot reload (code changes auto-restart)
   - Admin key: `ak_test_admin_key_e2e`
   - Docker project: `$PROJECT`

### `start:docker`

Full Docker mode — required for testing worker invocations and sandbox behavior.
The API runs inside Docker with the production sandbox (bwrap, pre-installed CLI/SDKs, document processing packages).

1. Write a minimal `.env` file (no `DATABASE_URL` — compose defaults to the postgres service):
   ```bash
   cat > .env <<EOF
   PORT=$API_PORT
   PG_PORT=$PG_PORT
   ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e
   ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   MEILI_MASTER_KEY=dev_meili_key
   POSTGRES_PASSWORD=arke
   ARKE_APP_PASSWORD=arke
   EOF
   ```

2. Make sure the local API is NOT running (would conflict on the port):
   ```bash
   lsof -ti:$API_PORT | xargs kill 2>/dev/null || true
   ```

3. Build and start everything:
   ```bash
   PG_PORT=$PG_PORT docker compose -p $PROJECT up -d --build
   ```
   Wait for the API to be healthy:
   ```bash
   for i in $(seq 1 20); do
     curl -s http://localhost:$API_PORT/health && break
     sleep 2
   done
   ```

4. For hot reload (watches source changes, auto-rebuilds on CLI/SDK changes):
   ```bash
   PG_PORT=$PG_PORT docker compose -p $PROJECT up --watch
   ```
   Note: `--watch` runs in the foreground. Use a separate terminal or run without `--watch` for background mode.

5. Confirm to the user:
   - Full Docker stack on port `$API_PORT`
   - Sandbox includes: bwrap, arkeon CLI, TypeScript SDK, Python SDK, document processing packages
   - Workers can use `pip install` for additional packages
   - Admin key: `ak_test_admin_key_e2e`

**Important:** When using `start:docker`, the `stop` command must also stop the Docker API container (not just a local process). The stop logic handles this automatically.

### `test`

1. Verify the API is running (start it if not — which also writes `.env`).
2. Run e2e tests:
   ```
   npm run test:e2e -w packages/api
   ```
   The `.env` file provides `ADMIN_BOOTSTRAP_KEY` and `E2E_BASE_URL` automatically.
3. Report results.

### `test:sandbox`

Run sandbox integration tests inside Docker to test the bwrap code path. This is **required** when changing `packages/runtime/src/sandbox.ts` or `packages/api/src/lib/worker-invoke.ts` — macOS always uses the fallback path and won't catch bwrap issues.

```bash
./scripts/test-sandbox.sh
```

This builds the production Docker image and runs `packages/runtime/test/sandbox.test.ts` inside it, testing shell execution, file I/O, env vars, curl, python3, timeouts, and namespace isolation. Runs twice: once with `seccomp=unconfined` (bwrap with namespaces) and once without (verifies fallback detection).

### `reset`

Use after schema changes (packages/schema). Wipes the DB and starts fresh.

1. Stop the local API process on this port:
   ```
   lsof -ti:$API_PORT | xargs kill 2>/dev/null || true
   ```

2. Tear down Postgres and wipe the volume:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT down -v
   ```

3. Write the `.env` file (see above).

4. Start fresh Postgres + migrations:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT up -d postgres migrate
   ```
   Wait for migrate to complete successfully.

5. Restart the API:
   ```
   npm run dev -w packages/api
   ```
   Run in background, verify with curl.

6. Confirm the fresh stack is up.

### `stop`

1. Stop the local API process on this port (if running locally):
   ```
   lsof -ti:$API_PORT | xargs kill 2>/dev/null || true
   ```

2. Stop all Docker services (Postgres, API if running in Docker, migrate):
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT down
   ```
   Note: this preserves the DB volume. Use `reset` to wipe it.

3. **Worktree cleanup:** If in a worktree (i.e., `$PROJECT` is NOT `arkeon`), also remove the stopped containers and volumes to avoid stale leftovers:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT down -v --remove-orphans
   ```
   This replaces step 2 for worktrees (use `down -v --remove-orphans` instead of plain `down`).
   **Never run this against the main `arkeon` project** — main's DB volume should be preserved.

4. Confirm everything is stopped.

### `status`

Show what's running across all worktrees:

```bash
# List all arkeon docker compose projects
docker compose ls --filter "name=arkeon"

# Show listening ports
lsof -iTCP -sTCP:LISTEN -P | grep -E '(tsx|postgres)' || echo "Nothing running"
```

## Important Notes

- **Two modes, don't mix:** Use `start` (local API) OR `start:docker` (Docker API), never both at the same time. They share the same port.
- **Worker testing requires Docker:** The local API fallback has no bwrap, no pre-installed SDKs, and a potentially stale CLI. Workers will fail or behave differently. Always use `start:docker` when testing worker invocations.
- Postgres always runs in Docker, port varies by worktree.
- The `ADMIN_BOOTSTRAP_KEY` must match between server and tests.
- `ENCRYPTION_KEY` is required for worker invocations (encrypts LLM API keys). Set it in `.env` — any 64-char hex string works for dev.
- After schema SQL changes, you MUST use `reset` — migrations run from scratch, no ALTER TABLE.
- Redis now starts by default as part of the full stack (`docker compose up`). In `start` mode (local API + docker Postgres only) you can start it individually: `REDIS_PORT=$((6379 + SLOT)) docker compose -p $PROJECT up -d redis`.
- Each worktree gets its own Docker volumes (namespaced by project name), so schema changes in one worktree don't affect others.
- Use `stop` or `reset` to clean up when done with a worktree — don't leave orphaned containers.

## What's in the Docker sandbox (start:docker only)

Workers running in the Docker environment get:
- **Sandbox isolation:** bwrap with PID/UTS/IPC namespaces, read-only root, writable workspace
- **Arkeon CLI:** Current build with all flags (`--space-id`, `--permissions`, etc.)
- **TypeScript SDK:** `import * as arkeon from '@arkeon-technologies/sdk'` (ESM, works from any directory)
- **Python SDK:** `import arkeon_sdk as arkeon`
- **Document packages:** pypdf, python-docx, openpyxl, python-pptx, ebooklib, Pillow, pandas, etc.
- **Self-install:** `pip install <package>` works inside the sandbox (PIP_TARGET pre-configured)
- **Image viewing:** `view_image` tool for multimodal models
- **python/python3:** Both available (symlinked)

See `docs/RUNTIME_ENVIRONMENT.md` for the full list.

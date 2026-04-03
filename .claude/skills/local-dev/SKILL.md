---
name: local-dev
description: Start the local development environment (Postgres + API with hot reload) and run e2e tests.
disable-model-invocation: true
argument-hint: [start|test|reset|stop|status]
allowed-tools: Bash(docker *, npm *, curl *, pkill *, sleep *, kill *, lsof *, ls *, cat *), Read, TaskOutput
---

# Local Development Environment

Manage the local dev stack: Dockerized Postgres + local API with hot reload.
Supports isolated per-worktree environments so multiple branches can run simultaneously.

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
DATABASE_URL=postgresql://arke_app:arke@localhost:$PG_PORT/arke
MIGRATION_DATABASE_URL=postgresql://arke:arke@localhost:$PG_PORT/arke
ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e
E2E_BASE_URL=http://localhost:$API_PORT
EOF
```

This file is gitignored. Write it on every `start` and `reset` to keep it in sync with the assigned ports.

## Commands

`$ARGUMENTS` determines the action:

### `start` (default if no argument)

1. Write the `.env` file (see above).

2. Check if Postgres is already running:
   ```
   docker compose -p $PROJECT --profile local-db ps postgres
   ```

3. If not running, start Postgres and run migrations:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT --profile local-db --profile migrate up -d postgres migrate
   ```
   Wait for migrate to exit successfully:
   ```
   docker compose -p $PROJECT --profile migrate logs -f migrate
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
   PG_PORT=$PG_PORT docker compose -p $PROJECT --profile local-db down -v
   ```

3. Write the `.env` file (see above).

4. Start fresh Postgres + migrations:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT --profile local-db --profile migrate up -d postgres migrate
   ```
   Wait for migrate to complete successfully.

5. Restart the API:
   ```
   npm run dev -w packages/api
   ```
   Run in background, verify with curl.

6. Confirm the fresh stack is up.

### `stop`

1. Stop the local API process on this port:
   ```
   lsof -ti:$API_PORT | xargs kill 2>/dev/null || true
   ```

2. Stop Postgres:
   ```
   PG_PORT=$PG_PORT docker compose -p $PROJECT --profile local-db down
   ```
   Note: this preserves the DB volume. Use `reset` to wipe it.

3. Confirm everything is stopped.

### `status`

Show what's running across all worktrees:

```bash
# List all arkeon docker compose projects
docker compose ls --filter "name=arkeon"

# Show listening ports
lsof -iTCP -sTCP:LISTEN -P | grep -E '(tsx|postgres)' || echo "Nothing running"
```

## Important Notes

- The API runs locally (not in Docker) for instant hot reload on code changes.
- Postgres runs in Docker, port varies by worktree.
- The `ADMIN_BOOTSTRAP_KEY` must match between server and tests.
- After schema SQL changes, you MUST use `reset` — migrations run from scratch, no ALTER TABLE.
- Redis is not started by default (scheduling disabled). Use `REDIS_PORT=$((6379 + SLOT)) docker compose -p $PROJECT --profile workers up -d redis` if needed.
- Do NOT start the Docker API container alongside the local API — they both use the same port.
- Each worktree gets its own Docker volumes (namespaced by project name), so schema changes in one worktree don't affect others.
- Use `stop` or `reset` to clean up when done with a worktree — don't leave orphaned containers.

---
name: local-dev
description: Start the local development environment (Postgres + API with hot reload) and run e2e tests.
disable-model-invocation: true
argument-hint: [start|test|reset|stop]
allowed-tools: Bash(docker *, npm *, curl *, pkill *, sleep *, kill *, lsof *), Read, TaskOutput
---

# Local Development Environment

Manage the local dev stack: Dockerized Postgres + local API with hot reload.

## Commands

`$ARGUMENTS` determines the action:

### `start` (default if no argument)

1. Check if Postgres is already running:
   ```
   docker compose --profile local-db ps postgres
   ```

2. If not running, start Postgres and run migrations:
   ```
   docker compose --profile local-db --profile migrate up -d postgres migrate
   ```
   Wait for migrate to exit successfully:
   ```
   docker compose --profile migrate logs -f migrate
   ```

3. Check if the API is already running on port 8000:
   ```
   curl -s http://localhost:8000/ 2>/dev/null
   ```

4. If not running, start the API locally with hot reload:
   ```
   ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e \
   DATABASE_URL=postgresql://arke_app:arke@localhost:5432/arke \
   npm run dev -w packages/api
   ```
   Run this in the background. Wait a few seconds, then verify with:
   ```
   curl -s http://localhost:8000/
   ```
   Should return `{"name":"arke-api","status":"ok"}`.

5. Confirm to the user that the stack is up:
   - Postgres on port 5432
   - API on port 8000 with hot reload (code changes auto-restart)
   - Admin key: `ak_test_admin_key_e2e`

### `test`

1. Verify the API is running (start it if not).
2. Run e2e tests:
   ```
   ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e npm run test:e2e -w packages/api
   ```
3. Report results.

### `reset`

Use after schema changes (packages/schema). Wipes the DB and starts fresh.

1. Stop the local API process:
   ```
   pkill -f "tsx.*packages/api" 2>/dev/null || true
   ```

2. Tear down Postgres and wipe the volume:
   ```
   docker compose --profile local-db down -v
   ```

3. Start fresh Postgres + migrations:
   ```
   docker compose --profile local-db --profile migrate up -d postgres migrate
   ```
   Wait for migrate to complete successfully.

4. Restart the API:
   ```
   ADMIN_BOOTSTRAP_KEY=ak_test_admin_key_e2e \
   DATABASE_URL=postgresql://arke_app:arke@localhost:5432/arke \
   npm run dev -w packages/api
   ```
   Run in background, verify with curl.

5. Confirm the fresh stack is up.

### `stop`

1. Stop the local API process:
   ```
   pkill -f "tsx.*packages/api" 2>/dev/null || true
   ```

2. Stop Postgres:
   ```
   docker compose --profile local-db down
   ```
   Note: this preserves the DB volume. Use `reset` to wipe it.

3. Confirm everything is stopped.

## Important Notes

- The API runs locally (not in Docker) for instant hot reload on code changes.
- Postgres runs in Docker on port 5432.
- The `ADMIN_BOOTSTRAP_KEY` must match between server and tests.
- After schema SQL changes, you MUST use `reset` — migrations run from scratch, no ALTER TABLE.
- Redis is not started by default (scheduling disabled). Use `docker compose --profile workers up -d redis` if needed.
- Do NOT start the Docker API container alongside the local API — they both use port 8000.

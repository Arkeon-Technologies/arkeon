---
name: local-dev
description: Start the local development environment (embedded Postgres + Meilisearch + API) and run e2e tests.
disable-model-invocation: true
argument-hint: [start|test|test:sandbox|reset|stop|status]
allowed-tools: Bash(npm *, npx *, curl *, pkill *, sleep *, kill *, lsof *, ls *, cat *, mkdir *, rm *), Read, TaskOutput
---

# Local Development Environment

Manage the local dev stack via the `arkeon` CLI. Everything runs as a single Node process — embedded Postgres, spawned Meilisearch, and the API server — no Docker.

## Worktree isolation

If you're in a worktree (path contains `.claude-worktrees/` or `.claude/worktrees/`), pick non-default ports and a scoped `ARKEON_HOME` so parallel worktrees don't collide:

1. Check for `.devports` in the worktree root. If it exists, read its values.
2. If not, pick a random slot 1-99 and verify the ports are free:
   ```bash
   SLOT=$((RANDOM % 99 + 1))
   PG_PORT=$((15433 + SLOT))
   API_PORT=$((8000 + SLOT))
   MEILI_PORT=$((17700 + SLOT))
   while lsof -iTCP:$PG_PORT -sTCP:LISTEN >/dev/null 2>&1 || \
         lsof -iTCP:$API_PORT -sTCP:LISTEN >/dev/null 2>&1 || \
         lsof -iTCP:$MEILI_PORT -sTCP:LISTEN >/dev/null 2>&1; do
     SLOT=$((RANDOM % 99 + 1))
     PG_PORT=$((15433 + SLOT))
     API_PORT=$((8000 + SLOT))
     MEILI_PORT=$((17700 + SLOT))
   done
   ```
3. Persist to `.devports`:
   ```bash
   cat > .devports <<EOF
   PG_PORT=$PG_PORT
   API_PORT=$API_PORT
   MEILI_PORT=$MEILI_PORT
   ARKEON_HOME=$PWD/.arkeon-state
   EOF
   ```

`ARKEON_HOME=$PWD/.arkeon-state` keeps each worktree's Postgres data and downloaded Meilisearch binary scoped to that worktree, so wiping one doesn't affect another. `.arkeon-state/` is gitignored.

Main tree (not a worktree) uses defaults: `PG_PORT=5433`, `API_PORT=8000`, `MEILI_PORT=7700`, `ARKEON_HOME=~/.arkeon`.

## Commands

`$ARGUMENTS` determines the action:

### `start` (default)

1. Load ports + ARKEON_HOME from `.devports` (or use defaults).
2. Check if already running: `curl -sf http://localhost:$API_PORT/health`.
3. If not running, start the stack:
   ```bash
   ARKEON_HOME="$ARKEON_HOME" nohup npx tsx packages/cli/src/index.ts start \
     --port $API_PORT --pg-port $PG_PORT --meili-port $MEILI_PORT \
     > /tmp/arkeon-$API_PORT.log 2>&1 &
   echo $! > /tmp/arkeon-$API_PORT.pid
   ```
4. Poll for health (up to 120s — first run downloads the ~100MB Meilisearch binary):
   ```bash
   for i in $(seq 1 60); do
     if curl -sf http://localhost:$API_PORT/health > /dev/null 2>&1; then break; fi
     sleep 2
   done
   ```
5. Pull the generated admin key from the log:
   ```bash
   grep "Admin API key" /tmp/arkeon-$API_PORT.log | tail -1 | awk '{print $NF}'
   ```
6. Confirm the stack is up and print: API port, admin key, ARKEON_HOME.

### `test`

1. Ensure the stack is running (call `start` if not).
2. Read the admin key from the log file.
3. Run e2e tests:
   ```bash
   E2E_BASE_URL=http://localhost:$API_PORT \
   ADMIN_BOOTSTRAP_KEY="$ADMIN_KEY" \
   npm run test:e2e -w packages/api
   ```
4. Report results.

### `test:sandbox`

Runs `packages/runtime/test/sandbox.test.ts`. On Linux, exercises real bubblewrap namespace isolation (install with `sudo apt-get install bubblewrap` if missing). On macOS, exercises the direct-execution fallback path.

```bash
./scripts/test-sandbox.sh
```

### `reset`

Wipes the Postgres data and Meilisearch index for this worktree's `ARKEON_HOME`.

1. Stop the running process (same as `stop`).
2. Wipe data:
   ```bash
   ARKEON_HOME="$ARKEON_HOME" npx tsx packages/cli/src/index.ts reset --force
   ```
   This removes `$ARKEON_HOME/data/` but preserves secrets and the downloaded Meilisearch binary. Use `--hard` to wipe everything.
3. Start fresh with `start`.

### `stop`

```bash
if [ -f /tmp/arkeon-$API_PORT.pid ]; then
  kill -TERM "$(cat /tmp/arkeon-$API_PORT.pid)" 2>/dev/null || true
  wait "$(cat /tmp/arkeon-$API_PORT.pid)" 2>/dev/null || true
  rm -f /tmp/arkeon-$API_PORT.pid /tmp/arkeon-$API_PORT.log
fi
```

The arkeon process's own signal handler drains the API → stops Meilisearch → stops Postgres cleanly. No orphan containers or volumes to worry about.

### `status`

```bash
# Check every known worktree's arkeon instance
for pidfile in /tmp/arkeon-*.pid; do
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    port=$(basename "$pidfile" .pid | sed 's/arkeon-//')
    echo "arkeon running on port $port (pid $pid)"
    curl -sf "http://localhost:$port/health" && echo ""
  fi
done
```

## Notes

- First run downloads the Meilisearch binary (~100MB) into `$ARKEON_HOME/bin/`. Cached after that.
- Secrets (admin key, encryption key, PG password, Meili master key) are generated on first run and stored in `$ARKEON_HOME/secrets.json`. `reset` preserves them; `reset --hard` wipes them.
- After schema SQL changes you should `reset` — there's no migration state tracker, so a fresh cluster is the reliable way to exercise the full migration chain.
- Worker sandbox tests (`test:sandbox`) require bubblewrap on Linux. On macOS the fallback path runs — it's not a real security boundary but it's fine for dev.

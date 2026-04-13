# Arkeon

Arkeon is a knowledge-graph platform for building and querying structured knowledge from unstructured sources. It pairs a typed entity graph with sandboxed agent runtimes for extraction, enrichment, and reasoning over your data.

This repository contains the core Arkeon platform: the API server, schema migrations, CLI, runtime, and supporting packages.

## Repository Layout

- `packages/arkeon` — CLI, API server, runtime, schema migrations, and shared types (published as `arkeon` on npm)
- `packages/sdk-ts` — TypeScript SDK (published as `@arkeon-technologies/sdk`)
- `packages/explorer` — Browser-based graph explorer

## Getting Started

Arkeon runs as a single Node process that manages its own embedded Postgres and Meilisearch. No Docker, no system services to install.

**Prerequisites:** Node.js 18.17+. That's it.

```bash
# 1. Install the CLI globally
npm install -g arkeon

# 2. Generate state directory + secrets, optionally configure an LLM
#    provider for the knowledge extraction pipeline.
arkeon init

# 3. Bring up the stack (embedded Postgres + Meilisearch + API) as a
#    background daemon, wait for it to be healthy, save credentials.
#    First run downloads a Meilisearch binary (~100MB) into
#    ~/.arkeon/bin/ — cached forever after that.
arkeon up

# 4. Load the bundled Genesis demo graph (76 entities, ~220 relationships).
arkeon seed
```

After `arkeon up`, the graph explorer is at
`http://localhost:8000/explore` and the API at `http://localhost:8000`.
The CLI is already pointed at the local instance and authenticated as
the bootstrap admin, so commands like `arkeon entities list`,
`arkeon search`, or `arkeon status` work immediately.

To stop the daemon: `arkeon down` (preserves data). To wipe data but
keep secrets + the downloaded Meilisearch binary: `arkeon reset`. To
wipe everything including secrets and binaries: `arkeon reset --hard`.

For a foreground-attached session (useful for dev / debugging), use
`arkeon start` instead of `arkeon up` — same stack, same state dir, but
Ctrl+C drains in place.

### State directory

All state lives in `~/.arkeon/` by default (override with `ARKEON_HOME`
or the global `--data-dir <path>` flag):

```
~/.arkeon/
  bin/meilisearch       # downloaded once, cached forever
  data/postgres/        # embedded Postgres cluster
  data/meili/           # Meilisearch index
  data/files/           # uploaded files (when STORAGE_BACKEND=local)
  secrets.json          # admin key, encryption key, PG password (mode 0600)
  pending-llm.json      # staged LLM config between `init` and `up`
  arkeon.pid / .log     # daemon pidfile + log when running via `up`
```

### Worker runtime (optional)

If you plan to run sandboxed worker agents, install the worker toolchain:

- **Linux**: `sudo apt-get install bubblewrap curl jq python3`
- **macOS**: `brew install curl jq python3` (no bubblewrap — uses unsandboxed fallback)

`arkeon start` / `up` will warn at boot if these are missing, but it
won't refuse to start. Workers that shell out to `bash` / `curl` /
`python3` will fail at run time if the tools aren't there.

Note: on macOS the worker sandbox is a direct-execution fallback, not
a real isolation boundary. Only run untrusted worker code on Linux
hosts with bubblewrap installed.

### Knowledge extraction pipeline (optional)

Off by default. Pre-configure the LLM provider at `init` time:

```bash
arkeon init \
  --llm-provider openai \
  --llm-base-url https://api.openai.com/v1 \
  --llm-api-key sk-... \
  --llm-model gpt-4.1-nano
arkeon up --knowledge
```

Or configure later against a running stack with
`arkeon knowledge config update`. See [`docs/ADVANCED.md`](./docs/ADVANCED.md)
for cost and behavior notes.

### Bring your own Postgres / Meilisearch

For enterprise installs that want to point at managed infrastructure:

```bash
export ARKEON_DATABASE_URL=postgresql://arke_app:PASSWORD@db.example.com:5432/arke
export ARKE_APP_PASSWORD=PASSWORD
export ARKEON_MEILI_URL=https://ms-xxxx.meilisearch.io
export ARKEON_MEILI_MASTER_KEY=...
arkeon up
```

`arkeon start` / `up` skip embedded Postgres / Meilisearch whenever
`ARKEON_DATABASE_URL` / `ARKEON_MEILI_URL` (or their unprefixed
aliases) are set. Migrations still run on startup via
`ARKEON_MIGRATION_DATABASE_URL` if you provide a superuser URL.

### Development (from a git checkout)

```bash
git clone https://github.com/Arkeon-Technologies/arkeon
cd arkeon
npm install
npm run build -w packages/sdk-ts                # prebuilt SDK is required
npm run build -w @arkeon-technologies/explorer  # explorer assets
npx tsx packages/arkeon/src/index.ts start       # foreground-attached stack
```

Typecheck and e2e tests:

```bash
npm run typecheck -w packages/arkeon
./scripts/test-local.sh    # brings up the stack via the CLI and runs e2e
```

## Documentation

Architecture notes, design rationale, and operational guidance live in [`docs/`](./docs).

## License

Arkeon's core is currently licensed under the [Apache License, Version 2.0](./LICENSE). Arkeon™ is a trademark of Arkeon Technologies, Inc.

Commercial enterprise features and the Arkeon hosted service are offered separately under commercial terms. See [arkeon.tech](https://arkeon.tech) for details.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors must sign our CLA, which is handled automatically by a bot when you open your first pull request.

## Security

To report a security vulnerability, please see [SECURITY.md](./SECURITY.md).

# Arkeon

Arkeon is a knowledge-graph platform for building and querying structured knowledge from unstructured sources. It pairs a typed entity graph with sandboxed agent runtimes for extraction, enrichment, and reasoning over your data.

This repository contains the core Arkeon platform: the API server, schema migrations, CLI, runtime, and supporting packages.

## Repository Layout

- `packages/api` — REST API server (Hono + Postgres)
- `packages/schema` — SQL migrations
- `packages/cli` — Command-line client (auto-generated from the API's OpenAPI spec)
- `packages/runtime` — Sandboxed worker / agent runtime
- `packages/sdk-ts` — TypeScript SDK
- `packages/explorer` — Browser-based graph explorer
- `packages/shared` — Shared types and utilities

## Getting Started

Arkeon ships as a single npm package that bundles a working
`docker-compose.yml`, an `.env.example` template, and a Genesis seed
graph. From a fresh machine you can be running a local stack with a
real, queryable knowledge graph in three commands.

**Prerequisites:** Node.js 18.17+ and Docker.

```bash
# 1. Install the CLI globally
npm install -g arkeon

# 2. From an empty directory, generate .env and docker-compose.yml,
#    and (optionally) configure an LLM provider for the extraction
#    pipeline. Press enter at the first LLM prompt to skip.
mkdir my-arkeon && cd my-arkeon
arkeon init

# 3. Bring up the stack (postgres + meilisearch + redis + api + migrate),
#    wait for it to be healthy, and store the bootstrap admin key locally.
arkeon up

# 4. Load the bundled Genesis demo graph (76 entities, ~220 relationships).
arkeon seed
```

After `arkeon up`, the dashboard explorer is at
`http://localhost:8000/explore` and the API at `http://localhost:8000`.
The CLI is already pointed at the local instance and authenticated as
the bootstrap admin, so commands like `arkeon entities list`,
`arkeon search`, or `arkeon status` work immediately.

To stop the stack: `arkeon down` (preserves data) or `arkeon down --volumes`
(wipes the postgres / meili / redis volumes).

For deployment, configuration, and architecture details, see the
[`docs/`](./docs) directory and the full env reference in
[`.env.example`](./.env.example).

## Documentation

Architecture notes, design rationale, and operational guidance live in [`docs/`](./docs).

## License

Arkeon's core is currently licensed under the [Apache License, Version 2.0](./LICENSE). Arkeon™ is a trademark of Arkeon Technologies, Inc.

Commercial enterprise features and the Arkeon hosted service are offered separately under commercial terms. See [arkeon.tech](https://arkeon.tech) for details.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors must sign our CLA, which is handled automatically by a bot when you open your first pull request.

## Security

To report a security vulnerability, please see [SECURITY.md](./SECURITY.md).

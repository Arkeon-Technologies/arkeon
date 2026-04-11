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

> **TBD — full quickstart coming soon.** A complete rewrite of this section is in flight; it will be updated alongside the public launch announcement.
>
> In the meantime, see [`.env.example`](./.env.example) for the required environment variables and [`docs/`](./docs) for architecture notes.

## Documentation

Architecture notes, design rationale, and operational guidance live in [`docs/`](./docs).

## License

Arkeon's core is currently licensed under the [Apache License, Version 2.0](./LICENSE). Arkeon™ is a trademark of Arkeon Technologies, Inc.

Commercial enterprise features and the Arkeon hosted service are offered separately under commercial terms. See [arkeon.tech](https://arkeon.tech) for details.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). All contributors must sign our CLA, which is handled automatically by a bot when you open your first pull request.

## Security

To report a security vulnerability, please see [SECURITY.md](./SECURITY.md).

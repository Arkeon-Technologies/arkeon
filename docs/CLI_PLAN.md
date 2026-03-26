# Arke CLI Plan

## Goal

Build a first-party `arke` CLI for the current `arke-api` that:

- exposes the full API surface from the API's own OpenAPI document
- provides proper local `--help` for every command and subcommand
- adds a polished one-command auth registration and recovery flow
- makes file upload and download easy, including presigned upload support

The CLI should be generated from the API spec where possible, with a small
handwritten layer for flows that are not well represented by generic JSON
request/response commands.

## Source of Truth

The API already exposes the required machine-readable and human-readable
metadata:

- `GET /openapi.json`
- `GET /help`
- `GET /help/:method/:path`

Relevant implementation:

- `src/app.ts`
- `src/lib/openapi-help.ts`
- route definitions under `src/routes/*`

The CLI should generate commands from the OpenAPI document at build time, not
at runtime.

Why build time:

- packaged CLI remains fast and usable offline
- no startup dependency on network availability
- command help stays stable for a released CLI version
- generation still comes directly from the API schema

## Repo Strategy

Use `arke-cli-v2` as the structural reference, but do not port it directly.

Keep these ideas:

- Commander-based command tree
- generated commands live separately from handwritten commands
- local config and credential storage

Do not reuse stale API wiring:

- old CLI auth paths no longer match this API
- old CLI points at older SDK assumptions and route layouts

Recommended approach:

1. create a fresh CLI package, likely `arke-cli`
2. copy over only reusable implementation ideas from `arke-cli-v2`
3. point generation directly at this API's OpenAPI output

## Architecture

The CLI should have four layers.

### 1. Core CLI Runtime

Responsibilities:

- root `Command` setup
- global flags
- config loading
- auth loading
- output formatting
- shared error handling

Suggested modules:

- `src/index.ts`
- `src/lib/config.ts`
- `src/lib/credentials.ts`
- `src/lib/http.ts`
- `src/lib/output.ts`
- `src/lib/errors.ts`

### 2. OpenAPI Fetch + Generator

Responsibilities:

- load OpenAPI JSON from local checked-in snapshot or from a provided URL/file
- parse paths, methods, params, schemas, summaries, and auth metadata
- emit generated command registrars
- emit generated help metadata and examples

Suggested modules:

- `scripts/fetch-openapi.ts`
- `scripts/generate-commands.ts`
- `src/generated/*`

Generation input priority:

1. local spec snapshot committed into the CLI repo
2. optional override with `ARKE_OPENAPI_URL` or a script arg during development

This avoids requiring the API server to be live for every CLI build.

### 3. Generic JSON Command Layer

Responsibilities:

- turn an OpenAPI operation into a Commander command
- map path params to positional args
- map query params to `--flags`
- map JSON request body fields to `--flags`
- support full JSON override via `--data <json>` and `--data-file <path>`
- call the API
- render JSON or table/plain output

This layer should cover most endpoints.

### 4. Handwritten UX Commands

Responsibilities:

- wrap multi-step auth flows
- wrap binary upload and download flows
- provide better UX than raw generated commands where needed

This layer should override generated commands when necessary.

## Command Design

The CLI should be resource-oriented and predictable.

Root command:

```text
arke
```

Top-level command groups:

- `auth`
- `commons`
- `entities`
- `relationships`
- `comments`
- `search`
- `activity`
- `actors`

Possible future groups:

- `help`
- `config`

### Naming Rules

Use the OpenAPI `operationId` as the primary naming source. Fall back to method
+ path only when needed.

Naming rules:

- resource name becomes the command group
- operation verb becomes the subcommand action
- path params become positional args
- nested resource verbs become explicit action names instead of deeply nested trees

Examples:

- `listCommons` -> `arke commons list`
- `createCommons` -> `arke commons create`
- `getCommons` -> `arke commons get <id>`
- `listCommonsEntities` -> `arke commons list-entities <id>`
- `listChildCommons` -> `arke commons list-children <id>`
- `createEntity` -> `arke entities create`
- `getEntity` -> `arke entities get <id>`
- `listEntityVersions` -> `arke entities list-versions <id>`
- `createEntityAccessGrant` -> `arke entities grant <id>`
- `deleteEntityAccessGrant` -> `arke entities revoke-grant <id> <actorId> <accessType>`
- `listRelationships` -> `arke entities relationships <id>`
- `createRelationship` -> `arke entities relate <id>`
- `getRelationship` -> `arke relationships get <relId>`

The generator should support explicit overrides for awkward names.

## Generated Command Rules

Generated commands should be the default for all JSON-oriented endpoints.

Each generated command should include:

- description from `summary`
- longer help text from `description` if present
- path arguments
- query flags
- body flags
- auth requirement note
- examples
- `--json`
- `--verbose`

Request body support:

- `--data '{"...": "..."}'`
- `--data-file ./body.json`
- individual flags for top-level body fields

Flag mapping rules:

- `snake_case` API field names become `--snake-case`
- required body fields are shown clearly in help
- enum values are printed in help text
- booleans should support both `--flag` and `--flag=false` where practical
- arrays and objects should accept JSON strings or `@file.json`

Response handling:

- default output should be readable, not raw dump-only
- `--json` should always return exact JSON response bodies
- 204 responses should print nothing except maybe a short success line in non-JSON mode

Error handling:

- preserve API error code and message
- show request ID when present
- avoid dumping stack traces unless `--verbose`

## Help Design

The CLI must have proper local `--help` everywhere.

Requirements:

- `arke --help`
- `arke auth --help`
- `arke entities create --help`
- `arke entities upload --help`

This should come from Commander help generation, enriched with OpenAPI metadata.

Each command help screen should include:

- summary
- usage
- arguments
- options
- auth requirement
- examples
- link or hint to corresponding API route if needed

The CLI should not depend on calling the server's `/help` endpoint just to show
help. The server help is a source of metadata, not the primary help UX.

Optional later enhancement:

- `arke api-help <METHOD> <path>`
- or `arke <command> --api-help`

That can surface server-side route help for debugging, but it is not required
for MVP.

## Auth UX

The auth flow should be handwritten.

Relevant API endpoints:

- `POST /auth/challenge`
- `POST /auth/register`
- `POST /auth/recover`
- `GET /auth/me`
- `POST /auth/keys`
- `GET /auth/keys`
- `DELETE /auth/keys/{id}`

### Primary Commands

- `arke auth register`
- `arke auth recover`
- `arke auth status`
- `arke auth logout`
- `arke auth me`
- `arke auth keys list`
- `arke auth keys create`
- `arke auth keys revoke <id>`
- `arke auth set-api-key <key>`

### `auth register`

This should be a one-command end-to-end flow:

1. generate Ed25519 keypair locally
2. call `POST /auth/challenge`
3. solve PoW locally
4. sign challenge nonce
5. call `POST /auth/register`
6. store API key and private key locally
7. print entity ID and key prefix

Optional flags:

- `--name <name>`
- `--metadata <json>`
- `--metadata-file <path>`
- `--force`

### `auth recover`

This should use the locally stored private key:

1. build exact recovery payload
2. sign it
3. call `POST /auth/recover`
4. replace stored API key
5. keep private key

### Credentials Storage

Store:

- API key
- API key prefix
- entity ID when known
- Ed25519 private key
- public key if convenient for status/recover
- base URL override if user configures one

Configuration inputs:

- env vars should override local config
- `ARKE_API_URL`
- `ARKE_API_KEY`

Suggested local commands:

- `arke config get`
- `arke config set api-url <url>`
- `arke config reset`

These can be phase 2 if we want to keep MVP smaller.

## File UX

File operations should be handwritten because they are binary and multi-step.

Relevant API endpoints:

- `POST /entities/{id}/content`
- `POST /entities/{id}/content/upload-url`
- `POST /entities/{id}/content/complete`
- `GET /entities/{id}/content`
- `DELETE /entities/{id}/content`
- `PATCH /entities/{id}/content`

### Primary Commands

- `arke entities upload <entityId> <file>`
- `arke entities download <entityId> [outputPath]`
- `arke entities delete-file <entityId>`
- `arke entities rename-file <entityId>`

Suggested flags for upload:

- `--key <contentKey>` required
- `--ver <n>` required
- `--filename <name>`
- `--content-type <mime>`
- `--strategy auto|direct|presigned`

### Upload Strategy

Default strategy: `auto`

Rules:

- use direct upload for smaller files
- use presigned upload for larger files
- allow user override

Presigned flow wrapper:

1. read file metadata locally
2. compute CID client-side if required by the API contract
3. call `POST /entities/{id}/content/upload-url`
4. `PUT` bytes to returned URL
5. call `POST /entities/{id}/content/complete`

Download flow:

- stream response to file if output path provided
- otherwise derive filename from `Content-Disposition` or use content key
- support stdout only if explicitly requested

## Generator Scope

The generator should cover these routes in phase 1:

- auth read-only and key management routes that are plain JSON
- commons
- entities except binary content UX commands
- comments
- relationships
- search
- activity
- actors
- inbox if exposed intentionally under auth or its own group

The generator should skip or allow explicit override for:

- `auth register`
- `auth recover`
- binary content endpoints

Implement overrides as a config map keyed by `operationId`.

Override map should support:

- `skip`
- custom group
- custom action
- custom positional arg order
- custom examples
- custom formatter

## Output Design

Default output should be readable for humans.

Suggested output modes:

- default pretty output
- `--json` for raw machine-readable output
- `--quiet` for reduced nonessential text

Examples:

- single entity responses: key fields in a compact block
- list responses: table-like output with cursor hint
- create/update responses: print returned IDs and versions prominently

Cursor-aware list commands should expose:

- `--limit`
- `--cursor`

and should print `next cursor` in non-JSON mode when present.

## API Client Design

Do not depend on an older SDK that may drift from this API.

Use a thin local HTTP client:

- base URL from config/env
- inject `Authorization: ApiKey ...` when available
- support JSON and binary requests
- support streaming download
- support upload via `fetch`

This keeps the CLI aligned to the API repo and avoids waiting for SDK release
steps just to ship CLI support for new endpoints.

Optional later:

- generate a typed client from this API schema
- use that client under the CLI

## Build and Spec Sync

Recommended CLI build flow:

1. export or fetch `openapi.json`
2. save normalized snapshot in the CLI repo
3. run generator
4. build CLI

Suggested scripts:

- `npm run fetch-spec`
- `npm run generate`
- `npm run build`
- `npm run typecheck`
- `npm run test`

Normalization during spec snapshotting should:

- sort paths and methods for stable diffs
- preserve custom `x-arke-*` fields
- avoid noisy timestamps or generated nondeterminism

## Testing Plan

### Unit Tests

- generator naming and override rules
- body/query flag coercion
- config and credential loading
- PoW solver correctness
- auth signing helpers

### Integration Tests

- `auth register` against a real dev API
- `auth recover`
- one generated CRUD flow for commons/entities
- one list endpoint with cursor handling
- one file upload via direct flow
- one file upload via presigned flow when configured
- representative `--help` snapshots

### Golden Tests

Store snapshots for:

- root help
- one generated command help
- one handwritten command help
- generated command registry

## Delivery Phases

### Phase 1: Base CLI

Target:

- every non-binary endpoint accessible
- local `--help` works for all commands
- auth register works end to end

Deliverables:

- CLI skeleton
- config and credential store
- thin HTTP client
- OpenAPI snapshot + generator
- generated command coverage for JSON endpoints
- handwritten auth commands

### Phase 2: File UX

Target:

- upload and download files ergonomically
- support direct and presigned upload strategies

Deliverables:

- upload/download/delete/rename commands
- local CID computation support
- progress output for larger transfers

### Phase 3: Polish

Target:

- stable release-quality UX

Deliverables:

- improved formatting
- shell completions
- `config` commands
- richer examples in help
- optional `api-help`

## Open Questions

These do not block phase 1, but should be decided early.

1. CLI repo location:
   fresh repo, or replace/rework `arke-cli-v2`
2. Spec source:
   direct fetch from local dev server, or export snapshot from source during CI
3. Output philosophy:
   mostly plain text blocks, or table-heavy output
4. File upload threshold:
   exact size cutoff for `auto` strategy
5. Private key storage:
   `conf` only, or OS keychain integration later

## Recommended Immediate Next Steps

1. Create the new CLI package skeleton.
2. Add a script that pulls and normalizes the API OpenAPI document.
3. Build the generator with an override map keyed by `operationId`.
4. Implement `auth register`, `auth recover`, and `auth status`.
5. Generate commands for all plain JSON endpoints and validate `--help`.
6. Add handwritten file commands after base coverage is working.

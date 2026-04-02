# @arkeon-technologies/cli

First-party CLI for the Arkeon API. Auto-generated commands from OpenAPI spec plus handwritten UX for auth and file operations.

## Install

```bash
npm install -g @arkeon-technologies/cli
```

## Available Commands

### Auth
- `arkeon auth register` — register a new agent (requires API endpoints)
- `arkeon auth recover` — recover access via identity key
- `arkeon auth set-api-key` — manually set an API key
- `arkeon auth status` / `whoami` — show current auth state
- `arkeon auth logout` — clear stored credentials

### Config
- `arkeon config set-arke <id>` — set default arke ID
- `arkeon config get-arke` — show current arke ID
- `arkeon config clear-arke` — remove stored arke ID
- `arkeon config show` — show all config

### Entity Content
- `arkeon entities upload <id> <file>` — upload file to entity
- `arkeon entities download <id>` — download entity content
- `arkeon entities delete-file <id>` — remove content entry
- `arkeon entities rename-file <id>` — rename content key

### Generated API Commands
Auto-generated from the OpenAPI spec covering: actors, arkes, auth, comments, entities, groups, relationships, search, spaces, workers, and activity.

```bash
arkeon <resource> <action> [args]
```

## Development

```bash
npm run dev -w packages/cli          # Watch mode
npm run fetch-spec -w packages/cli   # Fetch latest OpenAPI spec
npm run generate -w packages/cli     # Regenerate commands from spec
npm run build -w packages/cli        # Build (auto-regenerates)
```

## Configuration

Two environment variables:

```bash
export ARKE_API_URL="http://localhost:8000"
export ARKE_API_KEY="ak_..."
```

Credentials are stored locally via the `conf` library.

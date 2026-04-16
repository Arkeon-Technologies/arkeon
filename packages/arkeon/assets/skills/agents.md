# Arkeon

<!-- arkeon:managed — do not remove this comment; arkeon install agents uses it to detect and update this file -->

Arkeon is a knowledge graph platform. It runs as a local server managing Postgres + Meilisearch, exposing a REST API for entities, relationships, spaces, and full-text/vector search.

## Quick Reference

- **API docs (for LLMs):** `curl http://localhost:8000/llms.txt`
- **Route help:** `curl http://localhost:8000/help/{method}/{path}` (e.g., `/help/get/entities/:id`)
- **OpenAPI spec:** `curl http://localhost:8000/openapi.json`
- **Status:** `npx arkeon status`

## CLI

The `arkeon` CLI manages the local stack and provides commands for all API operations:

```bash
npx arkeon --help          # List all commands
npx arkeon start           # Start the stack (Postgres + Meilisearch + API)
npx arkeon stop            # Stop the stack
npx arkeon status          # Show running state, URLs, and version
```

### Key workflows

- **Ingest documents:** `npx arkeon init <space>`, then `npx arkeon add <files>`
- **Search:** `npx arkeon search query --q "term" --space-id <id>`
- **Explore the graph:** Open the explorer URL from `npx arkeon status`
- **Extract knowledge:** Use the arkeon-ingest skill/command to build entity graphs from documents
- **Cross-space linking:** Use the arkeon-connect skill/command to weave relationships across spaces

## Architecture

- Single Node.js process, no Docker required
- Embedded Postgres (via `embedded-postgres`) and Meilisearch binary
- State stored in `~/.arkeon/` (override with `ARKEON_HOME`)
- Spaces provide multi-tenant isolation; entities and relationships are scoped to spaces
- Classification levels (0-4) gate read access; write access requires level + ACL

## Knowledge Graph as Memory

This project has a persistent knowledge graph. **Check it before answering project questions. Write back when you learn something new.**

### Reading from the graph

Before answering domain-specific questions about this project, search the graph:

```bash
npx arkeon search query --q "<keywords>"
```

For deeper context, traverse from a known entity:

```bash
npx arkeon graph traverse --source id:<entity_id> --hops 2 --limit 20
```

Use `/arkeon-recall <topic>` (if available) for a structured knowledge brief.

### Writing back to the graph

When you discover new concepts, decisions, or relationships while working:

```bash
npx arkeon entities create --space-id <id> --type <type> --label "<label>" --description "<description>"
npx arkeon relationships create --source-id <id> --target-id <id> --predicate "<predicate>"
```

The graph is your long-term memory across conversations. Treat it as a shared knowledge base.

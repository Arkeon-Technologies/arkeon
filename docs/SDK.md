# Arkeon SDK: Lightweight API Wrappers

Minimal Python and TypeScript packages for programmatic access to any Arkeon network. Pre-authenticated HTTP clients with automatic space ID injection and cursor-based pagination.

**Status:** Implemented. Both SDKs are pre-installed in worker sandboxes alongside the Arkeon CLI.

- TypeScript: `packages/sdk-ts` — published as `@arkeon-technologies/sdk` on npm
- Python: `packages/sdk-python` — published as `arkeon-sdk` on PyPI

## Configuration

Environment variables (all optional):

```bash
export ARKE_API_URL="http://localhost:8000"       # defaults to this if unset
export ARKE_API_KEY="uk_..."                      # user key, klados key, or agent key
export ARKE_SPACE_ID="01XYZ..."                   # auto-injected into requests
```

No config files, no init calls, no client objects.

## TypeScript

```typescript
import * as arkeon from '@arkeon-technologies/sdk';

// CRUD
const entities = await arkeon.get('/entities', { params: { limit: '10' } });
const created = await arkeon.post('/entities', { type: 'note', properties: { label: 'Hello' } });
await arkeon.put(`/entities/${id}`, { ver, properties: { label: 'Updated' } });
await arkeon.del(`/entities/${id}`);

// Relationships — source entity in path, target in body
await arkeon.post(`/entities/${sourceId}/relationships`, {
  predicate: 'references',
  target_id: targetId,
});

// Pagination — async generator yields individual items across all pages
for await (const entity of arkeon.paginate('/entities', { limit: '50' })) {
  console.log(entity.id);
}

// Configuration — set programmatically (or use env vars)
arkeon.setSpaceId('01XYZ...');    // ARKE_SPACE_ID env var

// Errors
try { await arkeon.get('/missing'); }
catch (e) { /* ArkeError { status, code, requestId, details } */ }
```

Zero dependencies — native `fetch` (Node 18+). Exports: `get`, `post`, `put`, `patch`, `del`, `paginate`, `setSpaceId`, `getSpaceId`, `ArkeError`.

## Python

```python
import arkeon_sdk as arkeon

# CRUD
entities = arkeon.get("/entities", {"limit": 10})
created = arkeon.post("/entities", {"type": "note", "properties": {"label": "Hello"}})
arkeon.put(f"/entities/{eid}", {"ver": ver, "properties": {"label": "Updated"}})
arkeon.delete(f"/entities/{eid}")

# Relationships — source entity in path, target in body
arkeon.post(f"/entities/{source_id}/relationships", {
    "predicate": "references",
    "target_id": target_id,
})

# Pagination — iterator yields individual items across all pages
for entity in arkeon.paginate("/entities", {"limit": 50}):
    print(entity["id"])

# Configuration
arkeon.set_space_id("01XYZ...")    # ARKE_SPACE_ID env var

# Errors
from arkeon_sdk import ArkeError
try:
    arkeon.get("/missing")
except ArkeError as e:
    print(e.status, e.code, e.request_id)
```

One dependency: `httpx`. Exports: `get`, `post`, `put`, `patch`, `delete`, `paginate`, `set_space_id`, `get_space_id`, `ArkeError`.

## Features

- **Auto space_id injection**: reads `ARKE_SPACE_ID` env or `set_space_id()` and injects into body (POST/PUT) or query params (GET) when not already present
- **Structured errors**: `ArkeError` with `status`, `code`, `request_id`, `details` fields parsed from API response
- **Cursor pagination**: `paginate()` transparently follows cursor tokens, yielding individual items
- **Content-type detection**: returns parsed JSON for API responses, raw text for help/docs endpoints

## What the SDK is NOT

- No entity/space/relationship models or types
- No retry logic or rate limiting
- No validation or schema enforcement
- No CLI (already exists as `packages/cli`)

It returns the raw API response as JSON. The API is self-documenting (`/llms.txt`, `/help/:method/:path`) — the SDK just removes the boilerplate of calling it.

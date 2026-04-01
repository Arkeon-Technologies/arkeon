# Arkeon SDK: Lightweight API Wrappers

Minimal Python and TypeScript packages for programmatic access to any Arkeon network. Pre-authenticated HTTP clients with automatic network ID injection and cursor-based pagination.

**Status:** Implemented. Both SDKs are pre-installed in worker sandboxes alongside the Arkeon CLI.

- TypeScript: `packages/sdk-ts` — published as `@arkeon-technologies/sdk` on npm, globally available as `arkeon-sdk` in sandboxes
- Python: `packages/sdk-python` — published as `arkeon-sdk` on PyPI, pip-installed in sandboxes

## Configuration

Three environment variables (all optional):

```bash
export ARKE_API_URL="http://localhost:8000"       # defaults to this if unset
export ARKE_API_KEY="uk_..."                      # user key, klados key, or agent key
export ARKE_NETWORK_ID="01ABC..."                 # auto-injected into requests
```

No config files, no init calls, no client objects.

## TypeScript

```typescript
import * as arkeon from 'arkeon-sdk';

// CRUD
const entities = await arkeon.get('/entities', { params: { limit: '10' } });
const created = await arkeon.post('/entities', { type: 'note', properties: { label: 'Hello' } });
await arkeon.put(`/entities/${id}`, { ver, properties: { label: 'Updated' } });
await arkeon.del(`/entities/${id}`);

// Pagination — async generator yields individual items across all pages
for await (const entity of arkeon.paginate('/entities', { limit: '50' })) {
  console.log(entity.id);
}

// Network ID — set programmatically (or use ARKE_NETWORK_ID env var)
arkeon.setNetworkId('01ABC...');

// Errors
try { await arkeon.get('/missing'); }
catch (e) { /* ArkeError { status, code, requestId, details } */ }
```

Zero dependencies — native `fetch` (Node 18+). Exports: `get`, `post`, `put`, `patch`, `del`, `paginate`, `setNetworkId`, `getNetworkId`, `ArkeError`.

## Python

```python
import arkeon_sdk as arkeon

# CRUD
entities = arkeon.get("/entities", params={"limit": 10})
created = arkeon.post("/entities", {"type": "note", "properties": {"label": "Hello"}})
arkeon.put(f"/entities/{eid}", {"ver": ver, "properties": {"label": "Updated"}})
arkeon.delete(f"/entities/{eid}")

# Pagination — iterator yields individual items across all pages
from arkeon_sdk import paginate
for entity in paginate("/entities", {"limit": 50}):
    print(entity["id"])

# Network ID
arkeon.set_network_id("01ABC...")

# Errors
from arkeon_sdk import ArkeError
try:
    arkeon.get("/missing")
except ArkeError as e:
    print(e.status, e.code, e.request_id)
```

One dependency: `httpx`. Exports: `get`, `post`, `put`, `patch`, `delete`, `paginate`, `set_network_id`, `get_network_id`, `ArkeError`.

## Features

- **Auto network_id injection**: reads `ARKE_NETWORK_ID` or `set_network_id()` and injects into body (POST/PUT) or query params (GET) when not already present
- **Structured errors**: `ArkeError` with `status`, `code`, `request_id`, `details` fields parsed from API response
- **Cursor pagination**: `paginate()` transparently follows cursor tokens, yielding individual items
- **Content-type detection**: returns parsed JSON for API responses, raw text for help/docs endpoints

## What the SDK is NOT

- No entity/space/relationship models or types
- No retry logic or rate limiting
- No validation or schema enforcement
- No CLI (already exists as `packages/cli`)

It returns the raw API response as JSON. The API is self-documenting (`/llms.txt`, `/help/:method/:path`) — the SDK just removes the boilerplate of calling it.

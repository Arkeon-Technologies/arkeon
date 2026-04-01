# Arkeon SDK: Lightweight API Wrappers

Minimal Python and TypeScript packages for programmatic access to any Arkeon network. Zero abstraction — four functions (`get`, `post`, `put`, `delete`), auth from env vars, raw JSON responses.

**Status:** Implemented. Both SDKs are pre-installed in worker sandboxes alongside the Arkeon CLI.

- TypeScript: `packages/sdk-ts` — published as `@arkeon-technologies/sdk` on npm, globally available as `arkeon-sdk` in sandboxes
- Python: `packages/sdk-python` — published as `arkeon-sdk` on PyPI, pip-installed in sandboxes

See also: [Agent Runtime](../AGENT_RUNTIME.md) — both the Arkeon CLI and SDKs are pre-installed in agent sandboxes.

## Motivation

The CLI covers interactive and shell-script usage. But when writing a Python script to process data, a TypeScript service that syncs with external systems, or an AI agent that interacts with the network programmatically — you don't want to write auth headers and base URL construction every time.

The SDK is not a framework. It's a pre-authenticated HTTP client that reads `ARKE_API_URL` and `ARKE_API_KEY` from the environment and exposes the API as function calls. The API itself is self-documenting (`/llms.txt`, `/help/:method/:path`) — the SDK just removes the boilerplate of calling it.

## Configuration

Two environment variables:

```bash
export ARKE_API_URL="http://localhost:8000"   # defaults to this if unset
export ARKE_API_KEY="uk_..."                  # user key, klados key, or agent key
```

No config files, no init calls, no client objects to manage.

## Python (`arkeon-sdk` on PyPI)

```python
# arkeon_sdk/__init__.py — the entire package
import os, httpx

_url = os.environ.get("ARKE_API_URL", "http://localhost:8000")
_key = os.environ.get("ARKE_API_KEY", "")
_client = httpx.Client(
    base_url=_url,
    headers={"Authorization": f"ApiKey {_key}", "Content-Type": "application/json"},
)

def get(path, params=None):
    r = _client.get(path, params=params)
    r.raise_for_status()
    return r.json()

def post(path, json=None):
    r = _client.post(path, json=json)
    r.raise_for_status()
    return r.json()

def put(path, json=None):
    r = _client.put(path, json=json)
    r.raise_for_status()
    return r.json()

def delete(path):
    r = _client.delete(path)
    r.raise_for_status()
    return r.json()
```

Usage:

```python
import arkeon_sdk as arkeon

# List entities
entities = arkeon.get("/entities", params={"limit": 10})

# Create an entity
new = arkeon.post("/entities", {"kind": "entity", "properties": {"label": "Notes"}})

# Update
arkeon.put(f"/entities/{eid}", {"properties_merge": {"label": "Updated"}})

# Delete
arkeon.delete(f"/entities/{eid}")
```

One dependency: `httpx`. ~30 lines of code.

## TypeScript (`arkeon-sdk` on npm)

```typescript
// src/index.ts — the entire package
const baseUrl = process.env.ARKE_API_URL ?? 'http://localhost:8000';
const apiKey = process.env.ARKE_API_KEY ?? '';
const headers = { 'Authorization': `ApiKey ${apiKey}`, 'Content-Type': 'application/json' };

export class ArkeError extends Error {
    status: number; requestId?: string; code?: string;
    constructor(status: number, message: string, requestId?: string, code?: string) {
        super(message); this.name = 'ArkeError'; this.status = status;
        this.requestId = requestId; this.code = code;
    }
}

async function request(method: string, path: string, opts?: { json?: any; params?: Record<string, string> }) {
    const url = new URL(path, baseUrl);
    if (opts?.params) Object.entries(opts.params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { method, headers, body: opts?.json ? JSON.stringify(opts.json) : undefined });
    if (!res.ok) {
        const body = await res.json().catch(() => null) as any;
        throw new ArkeError(res.status, body?.error?.message ?? res.statusText, body?.error?.request_id, body?.error?.code);
    }
    if (res.status === 204) return undefined;
    return res.json();
}

export const get = (path: string, opts?: { params?: Record<string, string> }) => request('GET', path, opts);
export const post = (path: string, json?: any) => request('POST', path, { json });
export const put = (path: string, json?: any) => request('PUT', path, { json });
export const del = (path: string) => request('DELETE', path);
```

Usage:

```typescript
import * as arkeon from 'arkeon-sdk';

const entities = await arkeon.get('/entities', { params: { limit: '10' } });
await arkeon.post('/entities', { kind: 'entity', properties: { label: 'Notes' } });
```

Zero dependencies — uses native `fetch` (Node 18+). ~15 lines of code.

## What the SDK is NOT

- No entity/space/relationship models or types
- No pagination helpers or retry logic
- No validation or schema enforcement
- No auth token management beyond reading env vars
- No CLI (already exists as `packages/cli`)

It returns the raw API response as JSON. If you need something fancier, write it — the SDK is a starting point, not a boundary.

## Discovery

The API is self-documenting. To see what's available:

```python
import arkeon_sdk as arkeon

# Get the full API reference (designed for LLMs and humans)
docs = arkeon.get("/llms.txt")

# Get detailed help for a specific route
help = arkeon.get("/help/GET/entities")
```

## Use cases

- **Scripts**: data migration, bulk operations, scheduled exports
- **AI agents**: programmatic network access from within sandboxed agent runtimes
- **External services**: webhooks, integrations, sync pipelines
- **Notebooks**: Jupyter/Colab exploration of network data
- **Testing**: quick API interaction without curl boilerplate

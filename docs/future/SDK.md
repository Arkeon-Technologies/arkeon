# Arke SDK: Lightweight API Wrappers (Future Enhancement)

Minimal Python and TypeScript packages for programmatic access to any Arke network. Zero abstraction — four functions (`get`, `post`, `put`, `delete`), auth from env vars, raw JSON responses.

Lives in the monorepo as `packages/sdk-python` and `packages/sdk-ts`. Published to PyPI and npm as `arke-sdk`.

See also: [Agent Runtime](./AGENT_RUNTIME.md) — the SDK is pre-installed in agent sandboxes.

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

## Python (`arke-sdk` on PyPI)

```python
# arke_sdk/__init__.py — the entire package
import os, httpx

_url = os.environ.get("ARKE_API_URL", "http://localhost:8000")
_key = os.environ.get("ARKE_API_KEY", "")
_client = httpx.Client(
    base_url=_url,
    headers={"Authorization": f"ApiKey {_key}", "Content-Type": "application/json"},
)

def get(path, params=None):
    return _client.get(path, params=params).json()

def post(path, json=None):
    return _client.post(path, json=json).json()

def put(path, json=None):
    return _client.put(path, json=json).json()

def delete(path):
    return _client.delete(path).json()
```

Usage:

```python
import arke_sdk as arke

# List entities
entities = arke.get("/entities", params={"limit": 10})

# Create an entity
new = arke.post("/entities", {"kind": "entity", "properties": {"label": "Notes"}})

# Update
arke.put(f"/entities/{eid}", {"properties_merge": {"label": "Updated"}})

# Delete
arke.delete(f"/entities/{eid}")
```

One dependency: `httpx`. ~30 lines of code.

## TypeScript (`arke-sdk` on npm)

```typescript
// src/index.ts — the entire package
const baseUrl = process.env.ARKE_API_URL ?? 'http://localhost:8000';
const apiKey = process.env.ARKE_API_KEY ?? '';
const headers = { 'Authorization': `ApiKey ${apiKey}`, 'Content-Type': 'application/json' };

async function request(method: string, path: string, opts?: { json?: any; params?: Record<string, string> }) {
    const url = new URL(path, baseUrl);
    if (opts?.params) Object.entries(opts.params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { method, headers, body: opts?.json ? JSON.stringify(opts.json) : undefined });
    return res.json();
}

export const get = (path: string, opts?: { params?: Record<string, string> }) => request('GET', path, opts);
export const post = (path: string, json?: any) => request('POST', path, { json });
export const put = (path: string, json?: any) => request('PUT', path, { json });
export const del = (path: string) => request('DELETE', path);
```

Usage:

```typescript
import * as arke from 'arke-sdk';

const entities = await arke.get('/entities', { params: { limit: '10' } });
await arke.post('/entities', { kind: 'entity', properties: { label: 'Notes' } });
```

Zero dependencies — uses native `fetch` (Node 18+). ~15 lines of code.

## What the SDK is NOT

- No entity/space/relationship models or types
- No pagination helpers, retry logic, or error classes
- No validation or schema enforcement
- No auth token management beyond reading env vars
- No CLI (already exists as `packages/cli`)

It returns the raw API response as JSON. If you need something fancier, write it — the SDK is a starting point, not a boundary.

## Discovery

The API is self-documenting. To see what's available:

```python
import arke_sdk as arke

# Get the full API reference (designed for LLMs and humans)
docs = arke.get("/llms.txt")

# Get detailed help for a specific route
help = arke.get("/help/GET/entities")
```

## Use cases

- **Scripts**: data migration, bulk operations, scheduled exports
- **AI agents**: programmatic network access from within sandboxed agent runtimes
- **External services**: webhooks, integrations, sync pipelines
- **Notebooks**: Jupyter/Colab exploration of network data
- **Testing**: quick API interaction without curl boilerplate

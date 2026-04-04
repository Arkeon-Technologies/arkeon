# @arkeon-technologies/sdk

Lightweight TypeScript SDK for the [Arkeon](https://arkeon.tech) API. Zero dependencies — uses native `fetch` (Node 18+).

## Install

```bash
npm install @arkeon-technologies/sdk
```

## Configuration

Set environment variables (all optional):

```bash
export ARKE_API_URL="https://my-network.arkeon.tech"  # default: http://localhost:8000
export ARKE_API_KEY="uk_..."                           # API key
export ARKE_ID="01ABC..."                               # admin keys only (actors are scoped server-side)
```

## Usage

```typescript
import * as arkeon from '@arkeon-technologies/sdk';

// List entities
const result = await arkeon.get('/entities', { params: { limit: '10' } });

// Create an entity (arke_id auto-injected from env)
const created = await arkeon.post('/entities', {
  type: 'note',
  properties: { label: 'Hello' },
});

// Update (requires ver from a prior fetch)
await arkeon.put(`/entities/${id}`, {
  ver,
  properties: { label: 'Updated' },
});

// Delete
await arkeon.del(`/entities/${id}`);
```

## Pagination

Async generator that transparently follows cursor tokens:

```typescript
for await (const entity of arkeon.paginate('/entities', { limit: '50' })) {
  console.log(entity.id);
}
```

## Arke ID & Space ID

Actor API keys are automatically scoped to their arke by the server — you don't need to set this. Admin API keys operate across all arkes and must specify one explicitly:

```typescript
arkeon.setArkeId('01ABC...');   // or ARKE_ID env var
arkeon.setSpaceId('01XYZ...');  // or ARKE_SPACE_ID env var
```

Once set, both are injected into all requests (query params for reads, body for writes). Explicit values in individual requests take precedence.

## Error Handling

```typescript
import { ArkeError } from '@arkeon-technologies/sdk';

try {
  await arkeon.get('/missing');
} catch (e) {
  if (e instanceof ArkeError) {
    console.log(e.status);     // 404
    console.log(e.code);       // "not_found"
    console.log(e.requestId);  // UUID for debugging
    console.log(e.details);    // additional context
  }
}
```

## API

| Export | Description |
|--------|-------------|
| `get(path, opts?)` | GET request. `opts.params` for query string. |
| `post(path, json?)` | POST with JSON body. |
| `put(path, json?)` | PUT with JSON body. |
| `patch(path, json?)` | PATCH with JSON body. |
| `del(path)` | DELETE request. |
| `paginate(path, params?)` | Async generator over paginated list endpoints. |
| `setArkeId(id)` | Set default arke ID for all requests. |
| `getArkeId()` | Get current default arke ID. |
| `setSpaceId(id)` | Set default space ID for all requests. |
| `getSpaceId()` | Get current default space ID. |
| `ArkeError` | Error class with `status`, `code`, `requestId`, `details`. |

## API Discovery

The Arkeon API is self-documenting:

```typescript
// Full route index (designed for LLMs and humans)
const docs = await arkeon.get('/llms.txt');

// Detailed help for a specific route
const help = await arkeon.get('/help/GET/entities/{id}');
```

## License

MIT

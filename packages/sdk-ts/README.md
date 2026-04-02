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
export ARKE_ID="01ABC..."                               # auto-injected into requests
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

## Arke ID

Set once, injected automatically into all requests:

```typescript
arkeon.setArkeId('01ABC...');
// or use ARKE_ID env var
```

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

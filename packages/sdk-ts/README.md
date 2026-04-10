# @arkeon-technologies/sdk

Lightweight TypeScript SDK for the [Arkeon](https://arkeon.tech) API. Zero dependencies — uses native `fetch` (Node 18+).

## Install

```bash
npm install @arkeon-technologies/sdk
```

## Configuration

Set environment variables (all optional):

```bash
export ARKE_API_URL="https://my-instance.arkeon.tech"  # default: http://localhost:8000
export ARKE_API_KEY="uk_..."                            # API key
```

## Usage

```typescript
import * as arkeon from '@arkeon-technologies/sdk';

// List entities
const result = await arkeon.get('/entities', { params: { limit: '10' } });

// Create an entity
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

## Space ID

Set a default space so that every entity and relationship you create is automatically added to it:

```typescript
arkeon.setSpaceId('01XYZ...');  // or ARKE_SPACE_ID env var
```

Once set, the space ID is injected into all requests (query params for reads, body for writes). Explicit values in individual requests take precedence.

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

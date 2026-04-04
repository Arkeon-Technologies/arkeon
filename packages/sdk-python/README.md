# arkeon-sdk

Lightweight Python SDK for the [Arkeon](https://arkeon.tech) API.

## Install

```bash
pip install arkeon-sdk
```

## Quick start

```python
import arkeon_sdk as arke

# Configure via environment variables:
#   ARKE_API_URL   - API base URL (default: http://localhost:8000)
#   ARKE_API_KEY   - API key for authentication
#   ARKE_NETWORK_ID - Default network ID

# Or set the network at runtime:
arke.set_network_id("my-network-id")

# Create an entity
entity = arke.post("/entities", {"name": "Acme Corp", "entity_type": "organization"})

# List entities
entities = arke.get("/entities")

# Paginate through all results
for entity in arke.paginate("/entities", {"limit": 50}):
    print(entity["name"])
```

## API

All functions target the Arkeon REST API. See your instance's `/help` endpoint for full documentation.

| Function | Description |
|---|---|
| `get(path, params=None)` | GET request with optional query params |
| `post(path, json=None)` | POST request with optional JSON body |
| `put(path, json=None)` | PUT request with optional JSON body |
| `patch(path, json=None)` | PATCH request with optional JSON body |
| `delete(path)` | DELETE request |
| `paginate(path, params=None)` | Auto-paginate a list endpoint, yields items |
| `set_network_id(id)` | Set default network ID for all requests |

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `ARKE_API_URL` | `http://localhost:8000` | API base URL |
| `ARKE_API_KEY` | (empty) | API key for authentication |
| `ARKE_NETWORK_ID` | (empty) | Default network ID |

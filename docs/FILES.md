# File Storage

Binary content storage for entities using S3-compatible object storage or local filesystem.

## Storage Backends

| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `STORAGE_DIR` | `./data/files` | Local path (dev only) |
| `S3_ENDPOINT` | — | S3-compatible endpoint |
| `S3_BUCKET` | — | Bucket name |
| `S3_ACCESS_KEY_ID` | — | Access key |
| `S3_SECRET_ACCESS_KEY` | — | Secret key |
| `S3_REGION` | `auto` | Region (optional) |

## Content Map

Each entity can have multiple content entries in `properties.content`, keyed by string:

```json
{
  "properties": {
    "content": {
      "original": {
        "cid": "bafkrei...",
        "size": 1245678,
        "content_type": "application/pdf",
        "filename": "paper.pdf",
        "uploaded_at": "2026-03-24T12:00:00Z"
      }
    }
  }
}
```

## Key Concepts

- **Content-addressed**: Files stored at `{entityId}/{cid}`. Same content = same CID = no duplicates.
- **Immutable storage**: Old CIDs are never deleted. Previous versions remain accessible via `entity_versions`.
- **CAS-protected**: All mutations require the current `ver` to prevent conflicts.
- **Default key**: If no key or CID specified on download, the first key alphabetically is used.

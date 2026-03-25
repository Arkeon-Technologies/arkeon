# File Storage

Binary content storage for entities using Cloudflare R2.

## Overview

Any entity can have binary content attached — files, images, documents, etc. Content is stored in R2 (S3-compatible object storage) and addressed by CID (content identifier). Metadata is tracked in the entity's `properties.content` map.

This is the same R2 backend used in arke v1. The only change is where metadata lives: v1 stores it in KV manifests, arke-api stores it in the Postgres `properties` JSONB column.

## Content Map

Each entity can have multiple content entries, keyed by a string (e.g. `"v1"`, `"original"`, `"thumbnail"`):

```json
{
  "properties": {
    "label": "Research Paper",
    "content": {
      "original": {
        "cid": "bafkrei...",
        "size": 1245678,
        "content_type": "application/pdf",
        "filename": "paper.pdf",
        "uploaded_at": "2026-03-24T12:00:00Z"
      },
      "thumbnail": {
        "cid": "bafkrei...",
        "size": 45000,
        "content_type": "image/jpeg",
        "uploaded_at": "2026-03-24T12:01:00Z"
      }
    }
  }
}
```

## R2 Storage

- **Path format**: `{entityId}/{cid}` (content-addressed, immutable)
- **Bucket isolation**: Test entities (II-prefixed IDs) use `arke-files-test`, others use `arke-files-prod`
- **CID computation**: SHA-256 multihash, CIDv1, raw codec (`bafkrei...` prefix)
- **Max file size**: 500 MB
- **Deduplication**: Same content = same CID = same R2 path (no duplicate storage)

## Upload Flows

### Direct Upload (small files)

For files up to 500 MB streamed through the API:

```
POST /entities/:id/content?key=v1
Content-Type: application/pdf
<binary body>

-> 200 { cid, size, key, ver }
```

The API streams the body to R2, computes the CID, and updates the entity's content map.

### Presigned URL Upload (large files)

For bypassing the API and uploading directly to R2:

```
1. POST /entities/:id/content/upload-url
   { "cid": "bafkrei...", "content_type": "application/pdf", "size": 1245678 }
   -> { upload_url, r2_key, expires_at }

2. PUT <upload_url>
   <binary body>

3. POST /entities/:id/content/complete
   { "key": "v1", "cid": "bafkrei...", "size": 1245678, "content_type": "application/pdf", "ver": 1 }
   -> { cid, size, key, ver }
```

The client computes the CID locally, gets a presigned URL (15 min expiry), uploads directly to R2, then tells the API to finalize the metadata.

## Download

```
GET /entities/:id/content?key=v1
-> 200 (binary stream with Content-Type, Content-Length, Content-Disposition headers)
```

Can also download by CID directly: `?cid=bafkrei...`

If no key or CID specified, downloads the first key alphabetically.

## Content Management

| Endpoint | Purpose |
|----------|---------|
| `DELETE /entities/:id/content?key=v1&ver=2` | Remove content entry (metadata only, R2 file preserved) |
| `PATCH /entities/:id/content` | Rename a content key |

All mutating operations are CAS-protected via `ver`.

## Versioning

Content uploads bump the entity's `ver` and create a version snapshot in `entity_versions`. The R2 file at the old CID is never deleted — previous versions can always reference it.

Deleting a content entry only removes it from the current `properties.content` map. The R2 object and previous version snapshots are preserved.

## Presigned URL Infrastructure

Uses `aws4fetch` for AWS Signature V4 presigned URL generation:
- S3 endpoint: `https://{accountId}.r2.cloudflarestorage.com`
- Requires: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`
- Default expiry: 15 minutes

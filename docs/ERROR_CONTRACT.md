# Error Contract

Consistent JSON error shape for all `arke-api` endpoints.

## Shape

```json
{
  "error": {
    "code": "cas_conflict",
    "message": "Version mismatch",
    "details": {
      "entity_id": "01ABC...",
      "expected_ver": 3
    },
    "request_id": "..."
  }
}
```

## Fields

- `code`: stable machine-readable identifier
- `message`: short human-readable summary
- `details`: optional structured context safe to expose to clients
- `request_id`: optional trace identifier for logs and debugging

## Rules

- Every non-2xx response returns this shape.
- `code` values are stable across implementations.
- `message` should be concise and safe for UI display.
- `details` should explain validation failures or conflicts without leaking secrets.
- Unexpected exceptions should map to `internal_error`.

## Suggested codes

### Request validation

- `invalid_json`
- `invalid_body`
- `invalid_query`
- `invalid_path_param`
- `missing_required_field`
- `invalid_filter`
- `invalid_cursor`
- `invalid_regex`
- `unsupported_media_type`

### Auth

- `authentication_required`
- `invalid_api_key`
- `api_key_revoked`
- `forbidden`
- `pow_invalid`
- `pow_expired`
- `signature_invalid`

### Data and concurrency

- `not_found`
- `already_exists`
- `cas_conflict`
- `constraint_violation`
- `file_not_found`
- `payload_too_large`
- `not_implemented`

### Platform

- `rate_limited`
- `upstream_error`
- `internal_error`

## Status mapping

| Status | Typical codes |
|--------|---------------|
| `400` | `invalid_json`, `invalid_body`, `invalid_query`, `invalid_filter`, `invalid_regex` |
| `401` | `authentication_required`, `invalid_api_key`, `api_key_revoked`, `signature_invalid` |
| `403` | `forbidden` |
| `404` | `not_found`, `file_not_found` |
| `409` | `cas_conflict`, `already_exists`, `constraint_violation` |
| `410` | `pow_expired` |
| `413` | `payload_too_large` |
| `415` | `unsupported_media_type` |
| `429` | `rate_limited` |
| `500` | `internal_error`, `upstream_error` |
| `501` | `not_implemented` |

## Examples

Validation error:

```json
{
  "error": {
    "code": "invalid_filter",
    "message": "Invalid filter expression",
    "details": {
      "filter": "year>>2020"
    }
  }
}
```

CAS conflict:

```json
{
  "error": {
    "code": "cas_conflict",
    "message": "Version mismatch",
    "details": {
      "entity_id": "01ABC...",
      "expected_ver": 4
    }
  }
}
```

Not implemented:

```json
{
  "error": {
    "code": "not_implemented",
    "message": "Direct binary uploads are not implemented in MVP"
  }
}
```

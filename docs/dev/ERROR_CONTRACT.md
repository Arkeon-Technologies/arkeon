# Error Contract

Consistent JSON error shape for all API endpoints.

## Shape

```json
{
  "error": {
    "code": "cas_conflict",
    "message": "Version mismatch",
    "details": { "entity_id": "01ABC...", "expected_ver": 3 },
    "request_id": "..."
  }
}
```

- `code`: stable machine-readable identifier
- `message`: short human-readable summary
- `details`: optional structured context (never leaks secrets)
- `request_id`: trace identifier from `X-Request-ID` header or auto-generated

## Rules

- Every non-2xx response returns this shape
- `code` values are stable across versions
- Unexpected exceptions map to `internal_error`
- Invalid/revoked API keys currently proceed as unauthenticated (no specific 401 for bad keys)

## Error Codes by Category

**Request validation:** `invalid_json`, `invalid_body`, `invalid_query`, `invalid_request`, `invalid_filter`, `invalid_cursor`, `invalid_header`, `invalid_path_param`, `missing_required_field`, `missing_required_header`

**Auth:** `authentication_required`, `forbidden`, `invalid_state`

**Data/concurrency:** `not_found`, `already_exists`, `cas_conflict`, `file_not_found`, `file_too_large`

**Platform:** `internal_error`, `service_unavailable`, `scheduler_unavailable`, `not_available`

## Status Mapping

| Status | Typical codes |
|--------|---------------|
| `400` | `invalid_json`, `invalid_body`, `invalid_query`, `invalid_request`, `invalid_filter`, `invalid_header`, `invalid_path_param`, `invalid_state`, `missing_required_field`, `missing_required_header` |
| `401` | `authentication_required` |
| `403` | `forbidden` |
| `404` | `not_found`, `file_not_found` |
| `409` | `cas_conflict`, `already_exists`, `not_available` |
| `413` | `file_too_large` |
| `500` | `internal_error` |
| `503` | `service_unavailable`, `scheduler_unavailable` |

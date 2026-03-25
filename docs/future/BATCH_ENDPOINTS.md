# Batch Endpoints

Future bulk operations for creating/updating multiple entities in a single request.

## Motivation

Creating many entities in the same commons (e.g., 100 chapters of a book) currently requires N individual POST requests. Each one triggers the `update_commons_stats` trigger, which UPDATEs the commons row — serializing all N inserts on the same row lock.

## Planned Endpoint

```
POST /entities/batch
```

Accepts an array of entity creation payloads. All entities must target the same commons (single contribute access check).

## Implementation Notes

When implementing batch operations, the `update_commons_stats` trigger will fire per row. Two options:

1. **Disable trigger, bump manually**: Wrap the batch in a transaction, disable the trigger, insert all rows, then do one atomic `UPDATE entities SET entity_count = entity_count + N, last_activity_at = NOW() WHERE id = $commons_id`.

2. **Advisory lock**: The trigger already works correctly per-row, but concurrent per-row UPDATEs to the same commons row will serialize. An advisory lock on the commons ID could batch the counter update.

Option 1 is simpler and avoids N round-trips to the commons row.

## See Also

- `schema/010-commons-stats.sql` — trigger definition
- `CLAUDE.md` — existing batch + parent relationship pattern (1 batch POST + 1 GET + 1 PUT)

# Activity, Notifications & Space Stats

How changes propagate through the system.

## Three layers

Every mutation flows through three independent systems with different guarantees:

```
Mutation (POST/PUT/DELETE)
    |
    |-> [1] entity_activity     INSERT in same transaction (synchronous, guaranteed)
    |       |-> pg_notify()     real-time push via LISTEN/NOTIFY
    |
    |-> [2] notifications       fan-out via backgroundTask() (async, best-effort)
    |
    |-> [3] space stats         trigger on space_entities table (synchronous)
```

**Layer 1 (Activity)**: Canonical record. Inserted in the same transaction as the mutation — if the write commits, the activity is recorded. Used for changelogs, feeds, and actor history.

**Layer 2 (Notifications)**: Pre-computed per-agent inbox. Runs in a separate transaction after the response is sent. If the process terminates mid-fan-out, some notifications may be lost. Acceptable because notifications are ephemeral (15-day prune) and agents can always query `entity_activity` directly.

**Layer 3 (Space stats)**: Denormalized `entity_count` and `last_activity_at` on the spaces table, updated atomically via the `update_space_stats()` trigger on `space_entities`. No application code needed.

## Retention

- Permanent actions (`entity_created`, `ownership_transferred`) survive pruning indefinitely
- Transient activity is pruned after 15 days by the in-process retention scheduler (hourly sweep, see `packages/arkeon/src/server/lib/retention.ts`)
- Notifications are pruned after 15 days on the same schedule
- Entity versions are preserved indefinitely in `entity_versions`

## Agent polling pattern

Agents track their own read position. No server-side read/unread state.

```
1. GET /auth/me/inbox?since=<last_known_ts>
2. Process items, store the latest ts
3. Repeat
```

Check for new items without fetching: `GET /auth/me/inbox/count?since=<ts>`

## Notification recipients

| Recipient | When |
|-----------|------|
| Entity owner | Always |
| Grant holders | Always |
| Target entity owner | Relationship actions |
| Grantee | `access_granted` |

Self-actions are excluded. Duplicates are collapsed.

## Real-time push

A trigger on `entity_activity` fires `pg_notify('entity_activity', ...)` on every INSERT with `{ id, entity_id, actor_id, action }`.

LISTEN/NOTIFY does **not** work through PgBouncer in transaction mode. Real-time subscribers must use a direct (non-pooled) connection.

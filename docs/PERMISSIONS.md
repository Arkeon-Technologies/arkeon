# Entity-Level Permissions

Every entity governs its own view and edit permissions. No inheritance. A commons doesn't make its children public — each entity decides for itself. Permission checks are baked into every query, so unauthorized entities are simply invisible.

## Role hierarchy

Four roles, each inheriting the capabilities of the roles below it:

| Role | Can view | Can edit content | Can manage access | Can transfer ownership / delete |
|------|----------|-----------------|-------------------|-------------------------------|
| **Owner** | Yes | Yes | Yes | Yes |
| **Admin** | Yes | Yes | Yes | No |
| **Editor** | Yes | Yes | No | No |
| **Viewer** | Yes | No | No | No |

- **Owner**: Singular. Set at creation, transferable only by the current owner. Full control.
- **Admin**: Can add/remove viewers, editors, and other admins. Can change `view_access` and `edit_access` policies. Cannot transfer ownership or delete the entity.
- **Editor**: Can modify content (properties). Cannot touch permissions.
- **Viewer**: Can read the entity. Only relevant when `view_access = 'private'`.

Roles are stored in `entity_access.access_type`. Higher roles implicitly include lower ones — an admin doesn't need a separate `edit` grant.

## Permission columns

Three columns on every entity:

| Column | Values | Meaning |
|--------|--------|---------|
| `owner_id` | Actor ID | The entity's owner. Always has full access. |
| `view_access` | `public` / `private` | Who can see this entity |
| `edit_access` | `public` / `collaborators` / `owner` | Who can edit this entity |

Plus the `entity_access` join table for explicit grants.

### View permission resolution

```
1. view_access = 'public'                                    → allow
2. Actor is owner                                            → allow
3. Actor has any grant in entity_access (view, edit, admin)  → allow
4. Deny
```

Any grant implies view access — if you can edit, you can see it.

### Edit permission resolution

```
1. Actor is owner                                            → allow
2. edit_access = 'public'                                    → allow
3. edit_access = 'collaborators' AND actor has 'edit' or 'admin' grant → allow
4. Deny
```

### Admin permission resolution (manage access)

```
1. Actor is owner                                            → allow
2. Actor has 'admin' grant in entity_access                  → allow
3. Deny
```

## Query integration

Permission checks are a reusable SQL fragment appended to every listing query. Private entities you can't access simply don't appear in results.

### View check (appended to every SELECT)

```sql
AND (
  e.view_access = 'public'
  OR e.owner_id = $actor_id
  OR EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = e.id AND actor_id = $actor_id
  )
)
```

Note: no `access_type` filter needed — any grant (view, edit, admin) implies view access.

For unauthenticated requests, only `view_access = 'public'` matches.

### Edit check (on PUT/PATCH)

```sql
AND (
  e.owner_id = $actor_id
  OR e.edit_access = 'public'
  OR (e.edit_access = 'collaborators' AND EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = e.id AND actor_id = $actor_id
      AND access_type IN ('edit', 'admin')
  ))
)
```

### Admin check (on permission management endpoints)

```sql
AND (
  e.owner_id = $actor_id
  OR EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = e.id AND actor_id = $actor_id AND access_type = 'admin'
  )
)
```

### Application layer

```typescript
function viewCheck(actorId: string | null): SQL {
  if (!actorId) {
    return sql`AND e.view_access = 'public'`;
  }
  return sql`
    AND (
      e.view_access = 'public'
      OR e.owner_id = ${actorId}
      OR EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = e.id AND actor_id = ${actorId}
      )
    )
  `;
}

function editCheck(actorId: string): SQL {
  return sql`
    AND (
      e.owner_id = ${actorId}
      OR e.edit_access = 'public'
      OR (e.edit_access = 'collaborators' AND EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = e.id AND actor_id = ${actorId}
          AND access_type IN ('edit', 'admin')
      ))
    )
  `;
}

function adminCheck(actorId: string): SQL {
  return sql`
    AND (
      e.owner_id = ${actorId}
      OR EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = e.id AND actor_id = ${actorId}
          AND access_type = 'admin'
      )
    )
  `;
}
```

## Endpoints

### Update entity access policy

Change who can view/edit the entity. Owner or admin only.

```
PUT /entities/:id/access
{
  "view_access": "private",
  "edit_access": "collaborators"
}
```

Returns the updated access policy. Does not create a new entity version.

### Transfer ownership

Owner only. Previous owner is automatically granted admin access.

```
PUT /entities/:id/access/owner
{
  "owner_id": "new-owner-id"
}
```

### List access grants

Owner or admin. Returns all actors with explicit grants on this entity.

```
GET /entities/:id/access
```

Response:

```json
{
  "owner_id": "01OWNER...",
  "view_access": "private",
  "edit_access": "collaborators",
  "grants": [
    { "actor_id": "01ALICE...", "access_type": "admin", "granted_at": "2026-03-21T..." },
    { "actor_id": "01BOB...", "access_type": "edit", "granted_at": "2026-03-21T..." },
    { "actor_id": "01CAROL...", "access_type": "view", "granted_at": "2026-03-21T..." }
  ]
}
```

### Grant access

Owner or admin. Adds a viewer, editor, or admin to the entity.

```
POST /entities/:id/access/grants
{
  "actor_id": "01ALICE...",
  "access_type": "admin"
}
```

Returns 201 on success. Idempotent — granting the same access twice is a no-op (upsert).

If the actor already has a lower grant (e.g., `view`) and you grant `admin`, the grant is upgraded. If they already have a higher grant, no change.

### Revoke access

Owner or admin. Removes an explicit grant. Cannot revoke the owner's access.

```
DELETE /entities/:id/access/grants/:actor_id
```

Removes all grants for that actor on this entity. If you want to downgrade (admin → editor), revoke then re-grant.

An admin cannot revoke another admin's access — only the owner can remove admins. This prevents admin wars.

### Revoke specific access type

Owner or admin. Removes a specific grant level.

```
DELETE /entities/:id/access/grants/:actor_id/:access_type
```

Removes only the specified grant. An admin can revoke `edit` and `view` grants but not other `admin` grants.

## Permissions on permission endpoints

Summary of who can call what:

| Endpoint | Owner | Admin | Editor | Viewer |
|----------|-------|-------|--------|--------|
| `GET /entities/:id/access` | Yes | Yes | No | No |
| `PUT /entities/:id/access` | Yes | Yes | No | No |
| `PUT /entities/:id/access/owner` | Yes | No | No | No |
| `POST /entities/:id/access/grants` | Yes | Yes | No | No |
| `DELETE /entities/:id/access/grants/:actor_id` | Yes | Yes* | No | No |

*Admin can remove viewers and editors, but not other admins. Only the owner can remove admins.

## What commons governs

A commons does NOT govern the permissions of entities inside it. Each entity owns its own view/edit permissions.

A commons governs one thing: **who can create new works in it** (contribution access).

| `contribute_access` | Meaning |
|---------------------|---------|
| `public` | Any authenticated actor can create works in this commons |
| `members` | Only commons members can create works |

This is checked when creating a relationship from a work to a commons — it's about the right to place a work in the commons, not about the work's own permissions.

### Commons membership

Commons has its own `entity_access` grants like any entity. But it also has the `contribute_access` concept which is specific to commons (stored on the commons table):

```sql
CREATE TABLE commons (
  id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  contribute_access TEXT NOT NULL DEFAULT 'members'
);
```

"Can actor X create a work in commons Y?" →

```sql
-- If contribute_access = 'public' → allow
-- If contribute_access = 'members' → check entity_access for any grant on the commons
SELECT EXISTS(
  SELECT 1 FROM commons c
  JOIN entities e ON c.id = e.id
  WHERE c.id = $commons_id
  AND (
    c.contribute_access = 'public'
    OR e.owner_id = $actor_id
    OR EXISTS(
      SELECT 1 FROM entity_access
      WHERE entity_id = c.id AND actor_id = $actor_id
    )
  )
);
```

Any grant on the commons (viewer, editor, admin) implies membership and contribution rights when `contribute_access = 'members'`.

## Defaults on creation

| Field | Default |
|-------|---------|
| `owner_id` | The creating actor |
| `view_access` | `private` |
| `edit_access` | `owner` |

The client can override at creation time:

```json
{
  "kind": "work",
  "type": "book",
  "properties": { "label": "My Book" },
  "view_access": "public",
  "edit_access": "collaborators"
}
```

## Ownership transfer

When ownership transfers:

1. New owner is set on the entity
2. Previous owner is automatically granted `admin` access
3. Previous owner retains full management capability but can no longer transfer ownership or delete

## Performance

The `EXISTS` subquery on `entity_access` is fast:

- Indexed on `(actor_id, access_type)` — Postgres does an index lookup and short-circuits on first match
- For public entities, the OR evaluates left-to-right and skips the EXISTS entirely
- Higher roles don't need multiple grants — one `admin` row covers view + edit + admin
- The worst case (private entity, checking a specific actor) is still sub-millisecond via the primary key index

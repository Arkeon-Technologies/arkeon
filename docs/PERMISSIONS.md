# Entity-Level Permissions

Every entity governs its own view and edit permissions. No inheritance. A commons doesn't make its children public — each entity decides for itself. Permission checks are baked into every query, so unauthorized entities are simply invisible.

## Permission model

Three columns on every entity:

| Column | Values | Meaning |
|--------|--------|---------|
| `owner_id` | Actor ID | The entity's owner. Always has full access. |
| `view_access` | `public` / `private` | Who can see this entity |
| `edit_access` | `public` / `collaborators` / `owner` | Who can edit this entity |

Plus a join table `entity_access` for explicit grants to specific actors.

### View permission resolution

```
view_access = 'public'   → anyone can see it
view_access = 'private'  → only owner + actors granted 'view' in entity_access
```

### Edit permission resolution

```
edit_access = 'public'        → any authenticated actor can edit
edit_access = 'collaborators' → owner + actors granted 'edit' in entity_access
edit_access = 'owner'         → only the owner
```

The owner always has full view and edit access regardless of these settings.

## Query integration

Permission checks are a reusable SQL fragment appended to every listing query. Private entities you can't access simply don't appear in results — no "permission denied" on click, no leaking metadata.

### View check (appended to every SELECT)

```sql
AND (
  e.view_access = 'public'
  OR e.owner_id = $actor_id
  OR EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = e.id AND actor_id = $actor_id AND access_type = 'view'
  )
)
```

For unauthenticated requests, only `view_access = 'public'` matches — the OR short-circuits.

### Edit check (on PUT/PATCH/DELETE)

```sql
SELECT id FROM entities
WHERE id = $id
AND (
  e.owner_id = $actor_id
  OR edit_access = 'public'
  OR (edit_access = 'collaborators' AND EXISTS(
    SELECT 1 FROM entity_access
    WHERE entity_id = $id AND actor_id = $actor_id AND access_type = 'edit'
  ))
);
-- 0 rows → 403 Forbidden
```

### Application layer

The view check becomes a reusable function that every query builder calls:

```typescript
function viewCheck(actorId: string | null): SQL {
  if (!actorId) {
    // Unauthenticated: public only
    return sql`AND e.view_access = 'public'`;
  }
  return sql`
    AND (
      e.view_access = 'public'
      OR e.owner_id = ${actorId}
      OR EXISTS(
        SELECT 1 FROM entity_access
        WHERE entity_id = e.id AND actor_id = ${actorId} AND access_type = 'view'
      )
    )
  `;
}
```

This gets appended to every listing query. No entity ever leaks through.

## Granting access

### Owner operations

Only the owner can modify permissions:

```
PUT /entities/:id/access
{
  "view_access": "private",
  "edit_access": "collaborators"
}
```

### Adding/removing explicit grants

```
POST /entities/:id/access/grants   { actor_id: "...", access_type: "edit" }
DELETE /entities/:id/access/grants { actor_id: "...", access_type: "edit" }
```

These modify the `entity_access` table. No version bump on the entity — permission changes don't create new content versions.

## What commons governs

A commons does NOT govern the permissions of entities inside it. Each entity owns its own view/edit permissions.

A commons governs one thing: **who can create new works in it** (contribution access).

| `contribute_access` | Meaning |
|---------------------|---------|
| `public` | Any authenticated actor can create works in this commons |
| `members` | Only commons members (admin/member role) can create works |

This is a commons-specific concept — it's about the right to create a relationship (`in_commons`) to the commons, not about the entities themselves.

### Commons membership

Commons membership is about contribution rights, not view/edit rights:

```sql
CREATE TABLE commons_members (
  commons_id TEXT NOT NULL REFERENCES commons(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (commons_id, actor_id)
);
```

- **Admin**: Can modify commons settings, manage members, and delete the commons
- **Member**: Can create works in the commons (when `contribute_access = 'members'`)

Whether you can SEE the commons itself depends on the commons entity's own `view_access`. Whether you can see works INSIDE it depends on each work's own `view_access`.

## Defaults on creation

When creating a new entity, the API sets defaults:

| Field | Default |
|-------|---------|
| `owner_id` | The creating actor |
| `view_access` | `private` |
| `edit_access` | `owner` |

The client can override these at creation time:

```json
{
  "type": "book",
  "properties": { "label": "My Book" },
  "view_access": "public",
  "edit_access": "collaborators"
}
```

A commons might suggest defaults for works created within it (e.g., a public commons might suggest `view_access: 'public'` for new works), but these are suggestions — the creating actor can override them.

## Ownership transfer

The owner can transfer ownership:

```
PUT /entities/:id/access
{ "owner_id": "new-owner-id" }
```

When ownership transfers, the previous owner is automatically added to `entity_access` with both `view` and `edit` grants so they don't lose access to their own creation.

## Performance

The `EXISTS` subquery on `entity_access` is fast:

- Indexed on `(actor_id, access_type)` — Postgres does an index lookup and short-circuits on first match
- For public entities (`view_access = 'public'`), the OR evaluates left-to-right and skips the EXISTS entirely
- Most entities in a public commons will be public, so the check is essentially a column comparison

For the worst case (private commons with thousands of private works, user has explicit grants to hundreds), the EXISTS subquery is still sub-millisecond because it hits the primary key index on `entity_access(entity_id, actor_id, access_type)`.

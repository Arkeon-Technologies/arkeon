# Entity-Level Permissions

Every entity governs its own access. No inheritance. Permission checks are baked into every query — unauthorized entities are invisible.

## Role hierarchy

Five roles, each with specific capabilities:

| Role | View | Edit content | Contribute (add children) | Manage access | Transfer/delete |
|------|------|-------------|--------------------------|---------------|-----------------|
| **Owner** | Yes | Yes | Yes | Yes | Yes |
| **Admin** | Yes | Yes | Yes | Yes | No |
| **Contributor** | Yes | No | Yes | No | No |
| **Editor** | Yes | Yes | No | No | No |
| **Viewer** | Yes | No | No | No | No |

- **Owner**: Singular. Set at creation, transferable only by current owner.
- **Admin**: Can manage all access grants. Cannot transfer ownership or delete.
- **Contributor**: Can add children to this entity (containment relationships). Cannot edit the entity itself. Independent from editor.
- **Editor**: Can modify entity content (properties). Cannot manage access or add children. Independent from contributor.
- **Viewer**: Can read the entity. Only relevant when `view_access = 'private'`.

Admin implicitly includes editor + contributor capabilities. Contributor and editor are independent — having one doesn't grant the other.

## Permission columns

Four columns on every entity:

| Column | Values | Meaning |
|--------|--------|---------|
| `owner_id` | Actor ID | Always has full access |
| `view_access` | `public` / `private` | Who can see this entity |
| `edit_access` | `public` / `collaborators` / `owner` | Who can edit content |
| `contribute_access` | `public` / `contributors` / `owner` | Who can add children |

Plus the `entity_access` table for explicit grants (view, edit, contribute, admin).

### View resolution

```
1. view_access = 'public'                             → allow
2. Actor is owner                                     → allow
3. Actor has ANY grant in entity_access                → allow
4. Deny
```

Any grant implies view access.

### Edit resolution

```
1. Actor is owner                                     → allow
2. edit_access = 'public'                             → allow
3. edit_access = 'collaborators' AND actor has 'edit' or 'admin' grant → allow
4. Deny
```

### Contribute resolution

```
1. Actor is owner                                     → allow
2. contribute_access = 'public'                       → allow
3. contribute_access = 'contributors' AND actor has 'contribute' or 'admin' grant → allow
4. Deny
```

### Admin resolution

```
1. Actor is owner                                     → allow
2. Actor has 'admin' grant                            → allow
3. Deny
```

## Query integration

### View check (every SELECT)

```sql
AND (
  e.view_access = 'public'
  OR e.owner_id = $actor_id
  OR EXISTS(SELECT 1 FROM entity_access
            WHERE entity_id = e.id AND actor_id = $actor_id)
)
```

### Edit check (PUT/PATCH)

```sql
AND (
  e.owner_id = $actor_id
  OR e.edit_access = 'public'
  OR (e.edit_access = 'collaborators' AND EXISTS(
    SELECT 1 FROM entity_access WHERE entity_id = e.id
      AND actor_id = $actor_id AND access_type IN ('edit', 'admin')
  ))
)
```

### Contribute check (add child)

```sql
AND (
  e.owner_id = $actor_id
  OR e.contribute_access = 'public'
  OR (e.contribute_access = 'contributors' AND EXISTS(
    SELECT 1 FROM entity_access WHERE entity_id = e.id
      AND actor_id = $actor_id AND access_type IN ('contribute', 'admin')
  ))
)
```

## How it applies to each kind

All kinds use the same entity-level permissions. No specialized tables.

### Commons

A commons with `contribute_access = 'contributors'` and contributor grants is how you control who can add works. "Members" are just actors with contribute grants.

```
POST /entities/:commons_id/contains
{ "kind": "work", "type": "book", "properties": { "label": "..." } }
```

Checks contribute on the commons. No separate commons_members table needed.

### Works

A work with `contribute_access = 'contributors'` controls who can add parts. The work owner gets contribute access by default.

### Parts

A part has its own independent permissions. The work owner doesn't automatically get edit access on parts — that must be explicitly granted (done automatically at creation time).

### Relationships

Relationship entities have permissions too. The creator owns the relationship. Editing the relationship's metadata (description, source_text) requires edit on the relationship entity.

## Endpoints

| Endpoint | Method | Who | Purpose |
|----------|--------|-----|---------|
| `/entities/:id/access` | GET | Owner/Admin | List policy + grants |
| `/entities/:id/access` | PUT | Owner/Admin | Update access policies |
| `/entities/:id/access/owner` | PUT | Owner | Transfer ownership |
| `/entities/:id/access/grants` | POST | Owner/Admin | Add a grant |
| `/entities/:id/access/grants/:actor_id` | DELETE | Owner/Admin* | Revoke all grants |
| `/entities/:id/access/grants/:actor_id/:type` | DELETE | Owner/Admin* | Revoke specific grant |

*Admin can revoke view, edit, contribute. Only owner can revoke admin.

## Defaults

| Field | Default |
|-------|---------|
| `owner_id` | Creating actor |
| `view_access` | `private` |
| `edit_access` | `owner` |
| `contribute_access` | `owner` |

Override at creation:

```json
{
  "kind": "commons",
  "type": "research_group",
  "properties": { "label": "My Group" },
  "view_access": "public",
  "contribute_access": "contributors"
}
```

## Ownership transfer

When ownership transfers:
1. New owner is set
2. Previous owner automatically gets admin grant
3. Previous owner retains full management (except transfer/delete)

# Open Issues

Issues identified during route design review. Organized by area.

---

## 1. Default Access Policies

**File:** entities.ts — POST /entities

The default access levels need to change:
- `view_access` default → `public` (was `private`)
- `edit_access` default → `collaborators` (was `owner`)
- `contribute_access` default → `public` (was `owner`)

This also requires updating the `entities` table schema (001-entities.sql) since the defaults are defined there.

---

## 2. ~~Soft Deletion Model~~ RESOLVED

No DELETE endpoint. Tombstoning is a flag on PUT: `{ tombstone: true, ver: N }`. Snapshots current content as a version, clears properties, removes all outbound relationships. Everything else untouched. Restoring = another PUT with new properties.

---

## 3. ~~GET Entity Response Shape & Expansion~~ RESOLVED

GET /entities/:id returns the entity row only. No relationships or access grants — those have dedicated endpoints. Two query params for controlling properties:
- `?view=summary` — metadata + label only
- `?fields=label,description` — metadata + selected property keys
- Default is full entity with all properties.

---

## 4. ~~404 vs 403 Distinction~~ RESOLVED

Uses `entity_exists()` SECURITY DEFINER function to check existence bypassing RLS. If exists but RLS returns no rows → 403. If doesn't exist → 404.

---

## 5. ~~ETag / Conditional Request Strategy~~ RESOLVED

ETag uses `ver`. Since GET only returns the entity row (not relationships/access), the response only changes when content changes, which is when `ver` bumps.

---

## 6-9. ~~Containment Issues~~ RESOLVED

No parent_id or position columns. One hierarchy column: `commons_id` (which commons an entity belongs to). Organization between entities is done through relationships (e.g., "contains", "part_of") — not special-cased hierarchy. This keeps the data model flat and encourages explicit, typed relationships. If you want folder-like structure, create an entity of type "folder" and use relationships. Commons contents queryable via `WHERE commons_id = $id`.

---

## 10. ~~Archive Permission Model~~ RESOLVED

Public entities: anyone authenticated can archive. Private entities: owner/admin only. Encrypted archiving for private entities is a future enhancement.

---

## 11. ~~Archive Scope~~ RESOLVED

Current state snapshot only. No version history or activity in archives.

---

## 12. ~~Access Visibility~~ RESOLVED

Access grants are publicly readable — anyone can see who has access to any entity. The `entity_access` SELECT RLS policy is open (`USING (true)`). Modification (INSERT/DELETE) stays restricted to owner/admin. This also resolved a circular RLS dependency between `entities` and `entity_access` policies.

---

## 13. ~~Relationship Listing Consolidation~~ RESOLVED

Merged into one endpoint with `?direction=out|in` (default: `out`). Added `target_id` filter. Removed separate `/incoming` sub-route.

---

## 14. ~~Expansion/Preview Standard~~ RESOLVED

Each resource has its own endpoint — no cross-resource expansion on GET. When entities appear nested in other responses (relationship targets), they use summary format (id, kind, type, label). Use `?view=summary` or `?fields=` for controlling properties on direct entity GET.

---

## 15. ~~Version Lookup by CID~~ RESOLVED

Removed CID from entity_versions entirely. CID is computed at archive time for the full snapshot (not per-version). The Arweave TX ID in entity_activity is the proof.

---

## 16. Activity Filter Consistency

**File:** activity.ts — GET /activity

All activity endpoints should share the same filter options:
- `action` — filter by action type
- `since` — timestamp filter
- `actor_id` — filter by who did it
- `entity_type` — filter by entity kind/type (requires JOIN)

Currently only the per-entity endpoint has `action` and `since` filters. The global stream and actor activity endpoints should have the same options.

---

## 17. Auth: API Key Lookup

**File:** auth.ts — GET /auth/me

Note that `/auth/me` should work for both JWT and API key auth — lookup user_mapping by Supabase UUID (JWT) or by actor_id (API key).

---

## 18. Auth: Revoked Keys Visibility

**File:** auth.ts — GET /auth/keys

Should revoked keys appear in the list? Options:
- Default: exclude revoked, `?include_revoked=true` to include them
- Add a `revoked` boolean field in the response for clarity

---

## 19. Alpha Invites: Remove Entirely

**File:** auth.ts

Alpha invite system should be removed — everyone is invited. Drop the `alpha_invites` table from the schema and remove the three alpha endpoints. Simplifies auth flow.

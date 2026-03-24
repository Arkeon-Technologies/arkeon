# Open Issues

Issues identified during route design review. Organized by area.

---

## 1. ~~Default Access Policies~~ RESOLVED

Schema and route already use the correct defaults: `view_access = 'public'`, `edit_access = 'collaborators'`, `contribute_access = 'public'`.

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

## 16. ~~Activity Filter Consistency~~ RESOLVED

All three activity endpoints now share the same filter pattern: `since`, `action`, `actor_id`, `limit`, `cursor`. Global stream switched from ID-based cursoring to timestamp-based to match the others. `entity_type` filter deferred — not needed for v1.

---

## 17. ~~Auth: API Key Lookup~~ RESOLVED

Auth is now agent-only via Ed25519 + API keys. No JWT. `/auth/me` looks up entity by `actor_id` from the API key.

---

## 18. ~~Auth: Revoked Keys Visibility~~ RESOLVED

Default: exclude revoked keys. `?include_revoked=true` to include them with `revoked_at` field.

---

## 19. ~~Alpha Invites: Remove Entirely~~ RESOLVED

Removed. No `alpha_invites` table, no invite endpoints. Everyone is invited.

---

## 20. Recovery: Revoke All vs Keep

**File:** auth.ts — POST /auth/recover

Current design: recovery revokes ALL existing API keys and issues a fresh one. This assumes the reason for recovery is key compromise. Alternative: leave existing keys active and just issue an additional key. Current decision: revoke all (safer default).

---

## 21. Rate Limiting on Registration

**File:** auth.ts — POST /auth/register

Registration is unauthenticated and creates entities. Needs rate limiting to prevent spam. Options: IP-based in-memory counter, or Postgres-backed (count recent registrations per IP). Deferred for MVP — add before public launch.

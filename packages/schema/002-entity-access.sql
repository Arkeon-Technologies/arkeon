-- =============================================================================
-- Entity Access Grants
-- =============================================================================
--
-- Explicit permission grants from an entity to specific actors. This is the
-- only permissions table — it handles all access control for all entity kinds.
--
-- Four access types form a hierarchy:
--
--   owner (column on entities) > admin > contribute > edit > view
--
--   Owner:       Full control. Transfer ownership, delete, everything below.
--   Admin:       Manage access grants. Add/remove viewers, editors, contributors,
--                and other admins. Cannot transfer ownership or delete. Everything below.
--   Contributor: Add entities to this commons. Only meaningful on commons.
--                Cannot edit the entity itself. Implies view.
--   Editor:      Modify entity content (properties). Cannot manage access. Implies view.
--   Viewer:      Read the entity. Only relevant when view_access = 'private'.
--
-- Higher roles implicitly include lower capabilities:
--   admin  → can edit + contribute + view
--   contributor → can view (but NOT edit)
--   editor → can view (but NOT contribute)
--
-- Note: contributor and editor are independent — a contributor can add entities
-- to a commons but can't edit the commons itself, and an editor can edit the
-- entity but can't contribute. Admin and owner can do both.
--
-- Permission changes do NOT create new entity versions. The content didn't
-- change — just who can access it.
--
-- =============================================================================

CREATE TABLE entity_access (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  access_type TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, actor_id, access_type),
  CONSTRAINT valid_access_type CHECK (access_type IN ('view', 'edit', 'contribute', 'admin'))
);

-- "What can actor X access?" — used in every listing query's EXISTS check
CREATE INDEX idx_entity_access_actor ON entity_access(actor_id);

-- "Who has access to entity Y?" — used for listing grants on an entity
CREATE INDEX idx_entity_access_entity ON entity_access(entity_id);

-- =============================================================================
-- Permission Check SQL Fragments
-- =============================================================================
--
-- These are reusable WHERE clauses appended to queries. Each one short-circuits
-- on public access, then checks ownership, then checks grants.
--
-- VIEW CHECK (appended to every SELECT):
--   AND (
--     e.view_access = 'public'
--     OR e.owner_id = $actor_id
--     OR EXISTS(
--       SELECT 1 FROM entity_access
--       WHERE entity_id = e.id AND actor_id = $actor_id
--     )
--   )
--   Note: any grant implies view access, so no access_type filter needed.
--
-- EDIT CHECK (on PUT/PATCH):
--   AND (
--     e.owner_id = $actor_id
--     OR e.edit_access = 'public'
--     OR (e.edit_access = 'collaborators' AND EXISTS(
--       SELECT 1 FROM entity_access
--       WHERE entity_id = e.id AND actor_id = $actor_id
--         AND access_type IN ('edit', 'admin')
--     ))
--   )
--
-- CONTRIBUTE CHECK (on "add entity to commons"):
--   AND (
--     e.owner_id = $actor_id
--     OR e.contribute_access = 'public'
--     OR (e.contribute_access = 'contributors' AND EXISTS(
--       SELECT 1 FROM entity_access
--       WHERE entity_id = e.id AND actor_id = $actor_id
--         AND access_type IN ('contribute', 'admin')
--     ))
--   )
--
-- ADMIN CHECK (on permission management endpoints):
--   AND (
--     e.owner_id = $actor_id
--     OR EXISTS(
--       SELECT 1 FROM entity_access
--       WHERE entity_id = e.id AND actor_id = $actor_id
--         AND access_type = 'admin'
--     )
--   )
--
-- =============================================================================

-- =============================================================================
-- Endpoints
-- =============================================================================
--
-- List access (anyone who can view the entity):
--   GET /entities/:id/access
--   → { owner_id, view_access, edit_access, contribute_access, grants: [...] }
--
-- Update access policy (owner/admin):
--   PUT /entities/:id/access
--   { "view_access": "public", "edit_access": "collaborators", "contribute_access": "contributors" }
--
-- Transfer ownership (owner only):
--   PUT /entities/:id/access/owner
--   { "owner_id": "01NEW_OWNER..." }
--   Previous owner automatically gets admin grant.
--
-- Grant access (owner/admin):
--   POST /entities/:id/access/grants
--   { "actor_id": "01ALICE...", "access_type": "admin" }
--   Idempotent. If actor already has a lower grant, this adds the higher one.
--
-- Revoke access (owner/admin):
--   DELETE /entities/:id/access/grants/:actor_id
--   Removes all grants for that actor.
--   Admin can revoke view, edit, contribute. Only owner can revoke admin.
--
-- Revoke specific access type (owner/admin):
--   DELETE /entities/:id/access/grants/:actor_id/:access_type
--
-- =============================================================================

-- =============================================================================
-- Permissions on Permission Endpoints
-- =============================================================================
--
-- | Endpoint                                | Owner | Admin | Editor | Contributor | Viewer |
-- |-----------------------------------------|-------|-------|--------|-------------|--------|
-- | GET /entities/:id/access                | Yes   | Yes   | Yes*   | Yes*        | Yes*   |
-- | PUT /entities/:id/access                | Yes   | Yes   | No     | No          | No     |
-- | PUT /entities/:id/access/owner          | Yes   | No    | No     | No          | No     |
-- | POST /entities/:id/access/grants        | Yes   | Yes   | No     | No          | No     |
-- | DELETE /entities/:id/access/grants/...  | Yes   | Yes*  | No     | No          | No     |
--
-- * Anyone who can view the entity can read its access configuration and grants.
-- * Admin can revoke view, edit, contribute grants. Only owner can revoke admin.
--
-- =============================================================================

-- =============================================================================
-- Core Entities Table
-- =============================================================================
--
-- EVERYTHING is an entity. Commons, entities, users, agents, and
-- relationships are all entities with the same base structure. Three core
-- tables power the entire data model:
--
--   entities          — every object in the system
--   entity_access     — permission grants (view, edit, admin, contribute)
--   relationship_edges — the graph structure (source → target)
--
-- Plus supporting tables:
--   entity_versions   — content snapshots (properties at each ver)
--   entity_activity   — chronological log of everything that happens
--
-- TWO PRIMARY KINDS:
--
--   commons  — Organizational containers / access boundaries. Commons nest
--              via commons_id pointing to the parent commons.
--
--   entity   — Everything else. Books, chapters, documents, files, people.
--              Entities always belong to a commons (via commons_id).
--              Structure between entities is expressed through relationships
--              (e.g., "contains", "part_of", "authored_by") — not hierarchy.
--
-- Plus structural kinds: relationship, user, agent.
--
-- ONE HIERARCHY COLUMN:
--
--   commons_id — Which commons this belongs to. Required for entities and
--                sub-commons. NULL only for The Arke (root commons), users,
--                and agents.
--
-- ORGANIZATION WITHIN A COMMONS:
--
-- There is no parent_id or position column. If you want folder-like
-- structure, create an entity of type "folder" (or "collection", "series",
-- whatever makes sense) and use relationships to connect things to it.
-- This keeps the data model flat and encourages explicit, typed relationships
-- over implicit hierarchy that hides meaning.
--
-- Entities have two layers of typing:
--
--   kind  — Structural role. Fixed enum: commons, entity, relationship,
--           user, agent.
--
--   type  — Semantic type. Open-ended: book, painting, person, chapter,
--           cites, contains, etc.
--
-- VERSIONING:
--
-- ver increments ONLY on content changes (properties). Relationships,
-- permissions, and structural changes don't bump ver — they're tracked
-- in entity_activity instead. CAS uses ver (not CID):
--
--   UPDATE entities SET ver = ver + 1, ...
--   WHERE id = $id AND ver = $expected_ver
--
-- CID computation is a future enhancement (see docs/future/ARWEAVE_ATTESTATION.md).
--
-- updated_at bumps on CONTENT changes only (when ver increments).
-- Set by application code in the same UPDATE, not by trigger.
-- ETag uses ver. Clients use entity_activity for broader change tracking.
--
-- =============================================================================

CREATE TABLE entities (
  -- Identity
  id TEXT PRIMARY KEY,                              -- ULID (26 chars)
  kind TEXT NOT NULL,                               -- structural: commons, entity, relationship, user, agent
  type TEXT NOT NULL,                               -- semantic: book, chapter, person, etc. (for relationships: always 'relationship')

  -- Version chain (content versions only — relationships/permissions don't bump ver)
  ver INTEGER NOT NULL DEFAULT 1,                   -- monotonically increasing, content changes only

  -- Content
  properties JSONB NOT NULL DEFAULT '{}',           -- type-specific data

  -- Permissions (every entity governs its own access)
  owner_id TEXT NOT NULL,                           -- who owns this entity (always has full access)
  view_access TEXT NOT NULL DEFAULT 'public',        -- 'public' | 'private'
  edit_access TEXT NOT NULL DEFAULT 'collaborators', -- 'public' | 'collaborators' | 'owner'
  contribute_access TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'contributors' | 'owner'

  -- Commons membership
  commons_id TEXT REFERENCES entities(id),           -- which commons (NULL for The Arke, users, agents)

  -- Audit
  edited_by TEXT NOT NULL,                          -- actor ID who made the latest content edit
  note TEXT,                                        -- optional version note

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL,                  -- immutable, set at creation
  updated_at TIMESTAMPTZ NOT NULL,                  -- bumped on content changes only (when ver increments)

  -- Constraints
  CONSTRAINT valid_kind
    CHECK (kind IN ('commons', 'entity', 'relationship', 'user', 'agent')),
  CONSTRAINT valid_view_access
    CHECK (view_access IN ('public', 'private')),
  CONSTRAINT valid_edit_access
    CHECK (edit_access IN ('public', 'collaborators', 'owner')),
  CONSTRAINT valid_contribute_access
    CHECK (contribute_access IN ('public', 'contributors', 'owner'))
);

-- =============================================================================
-- Indexes
-- =============================================================================

CREATE INDEX idx_entities_kind ON entities(kind);
CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_kind_type_updated ON entities(kind, type, updated_at DESC);
CREATE INDEX idx_entities_updated ON entities(updated_at DESC);
CREATE INDEX idx_entities_owner ON entities(owner_id);
CREATE INDEX idx_entities_edited_by ON entities(edited_by, updated_at DESC);
CREATE INDEX idx_entities_commons ON entities(commons_id);

-- =============================================================================
-- CAS Update Pattern
-- =============================================================================
--
-- Compare-and-swap using ver (not CID):
--
--   UPDATE entities
--   SET ver = ver + 1,
--       properties = $new_props,
--       edited_by = $actor_id,
--       note = $note,
--       updated_at = NOW()
--   WHERE id = $id AND ver = $expected_ver
--   RETURNING *;
--
-- If 0 rows returned → CAS conflict OR permission denied → 409.
-- Client retries with fresh ver (re-reads entity).
--
-- No CID computation needed. No manifest serialization. Just an integer check.
--
-- =============================================================================

-- =============================================================================
-- Conditional Read Pattern (ETag)
-- =============================================================================
--
-- Client sends If-None-Match header with last known ver:
--
--   If-None-Match: "3"   (ver value)
--
-- If ver == client's ETag → 304 Not Modified
-- If different → return full entity
--
-- ver only bumps on content changes. For broader change tracking
-- (relationships, permissions, comments), clients poll entity_activity.
--
-- =============================================================================

-- =============================================================================
-- The Arke (Root Commons)
-- =============================================================================
--
-- The Arke is the root commons — the single commons with commons_id = NULL.
-- Bootstrapped at system creation (like ARCHON in v1).
--
-- All other commons default to belonging to The Arke (commons_id = The Arke's ID).
-- All entities must belong to a commons — The Arke or a sub-commons.
-- Users and agents are system-level and do NOT belong to any commons.
--
-- Bootstrap:
--   INSERT INTO entities (id, kind, type, ver, properties, owner_id, commons_id,
--                         edited_by, created_at, updated_at)
--   VALUES ('00000000000000000000000000', 'commons', 'commons', 1,
--           '{"label": "The Arke"}', 'SYSTEM', NULL,
--           'SYSTEM', NOW(), NOW());
--
-- =============================================================================

-- =============================================================================
-- Structural Change Permissions
-- =============================================================================
--
-- commons_id is updateable via PUT. This is a structural change — it does NOT
-- bump ver (logged in entity_activity instead).
--
-- Setting commons_id:
--   Requires contribute access on the NEW commons.
--   Also requires edit access on the entity itself.
--
-- Activity log:
--   commons_id change → 'commons_changed', detail: { from, to }
--
-- =============================================================================

-- =============================================================================
-- Query Patterns
-- =============================================================================
--
-- Get entity by ID:
--   SELECT * FROM entities WHERE id = $id;
--
-- Everything in a commons:
--   SELECT * FROM entities
--   WHERE commons_id = $commons_id AND kind = 'entity'
--   ORDER BY updated_at DESC LIMIT 50;
--
-- Sub-commons of a commons:
--   SELECT * FROM entities
--   WHERE kind = 'commons' AND commons_id = $parent_commons_id;
--
-- Batch fetch:
--   SELECT * FROM entities WHERE id = ANY($ids);
--
-- Entities related to another entity (folder contents, book chapters, etc.):
--   Use relationship_edges — see 003-relationship-edges.sql
--
-- =============================================================================

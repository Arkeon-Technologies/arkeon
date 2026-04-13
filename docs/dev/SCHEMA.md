# Schema

Overview of the Postgres schema and migration system.

## Migration system

Migrations live in `packages/arkeon/src/schema/` as numbered SQL files
(001 through 038). The runner (`migrate.ts`) executes them in order on
every startup — there is no migration state tracker.

**Every migration must be idempotent.** A migration that worked once
will run again on the next deploy and must not fail. Rules:

- `CREATE TABLE` / `CREATE INDEX` — use `IF NOT EXISTS`
- `ALTER TABLE ADD COLUMN` — use `ADD COLUMN IF NOT EXISTS`
- `ALTER TABLE DROP COLUMN` / `DROP CONSTRAINT` — use `IF EXISTS`
- `DROP TABLE` / `DROP INDEX` — use `IF EXISTS`
- `INSERT` seed data — use `ON CONFLICT ... DO NOTHING`
- Do not use loadable extensions (`CREATE EXTENSION`)

Test by running `arkeon migrate` twice in a row — the second must succeed.

### Adding a new migration

1. Create `src/schema/NNN-descriptive-name.sql` (next number in sequence)
2. Follow idempotency rules above
3. The runner splits on semicolons, handling dollar-quoted blocks (`$$`)
   and comments correctly
4. Template variable `:'arke_app_password'` is replaced at runtime

### Runner internals

`runMigrations()` in `migrate.ts` is called in-process by `arkeon start` —
no child process, no spawn. It connects as superuser, iterates SQL files,
applies template variables, splits statements, and executes them. Errors
with code `42P07` (already exists) or `42703` (column not found during
rename) are silently skipped for idempotency.

## Core tables

### actors

Authenticated identities: agents (humans/bots with API keys) and workers
(sandboxed AI agents with system-managed keys).

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | Primary key |
| kind | TEXT | `agent` or `worker` |
| max_read_level | INT | Classification ceiling (0–4) |
| max_write_level | INT | Write ceiling |
| is_admin | BOOL | Bypasses all ACL checks |
| owner_id | FK actors | Who created this actor |
| properties | JSONB | Name, config, etc. |
| status | TEXT | `active`, `suspended`, `deactivated` |

### entities

Knowledge graph nodes. Every piece of content, concept, document, or
relationship is an entity.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | Primary key |
| kind | TEXT | `entity` or `relationship` |
| type | TEXT | Semantic type (book, person, concept, ...) |
| ver | INT | Monotonically increasing version |
| properties | JSONB | Type-specific content |
| owner_id | FK actors | Creator |
| read_level | INT | Classification (0–4) |
| write_level | INT | Write classification |
| edited_by | FK actors | Last editor |

### relationship_edges

Graph structure joining entities. Each edge is also an entity (kind =
`relationship`) with its own properties and permissions.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (FK entities) | The relationship entity |
| source_id | FK entities | From node |
| target_id | FK entities | To node |
| predicate | TEXT | Edge label (`cites`, `contains`, ...) |

Read access requires `max(source.read_level, target.read_level)` to
defend against inference attacks.

### spaces

Curated entity collections with their own permission model.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT (ULID) | Primary key |
| name | TEXT | Display name |
| owner_id | FK actors | |
| read_level, write_level | INT | Classification |
| entity_count | INT | Denormalized, maintained by trigger |

Join table `space_entities` links entities to spaces. `space_permissions`
grants `admin`, `editor`, or `contributor` roles.

### api_keys

Authentication tokens. Keys are SHA-256 hashed; only the prefix is stored
in cleartext for display.

### entity_permissions

Write ACL grants. Roles: `admin` (full control) and `editor` (can edit
properties). Read access is controlled solely by classification levels,
not by grants.

### groups / group_memberships

Actor groups (org, project, editorial, admin types). Groups can be
grantees in `entity_permissions` and `space_permissions`.

## Access control

Two layers enforced by Postgres RLS:

1. **Classification levels (reads):** `actor.max_read_level >= entity.read_level`
2. **ACL grants (writes):** Actor must have sufficient classification
   *and* an explicit grant (owner, admin, or editor) on the entity or
   its space

Session context is set by middleware via `SET LOCAL`:
- `app.actor_id`
- `app.actor_read_level`, `app.actor_write_level`
- `app.actor_is_admin`

RLS policies reference these session variables. Admin actors bypass
all policies.

## Audit trail

- **entity_versions** — snapshots of every entity version (properties, ver, note)
- **entity_activity** — event log (create, update, delete, content changes)
- **notifications** — per-actor notifications triggered by activity

## Supporting tables

| Migration | Table(s) | Purpose |
|-----------|----------|---------|
| 013 | comments | Entity discussion threads |
| 017, 021–025 | worker_invocations | Worker job queue + history |
| 029–037 | knowledge_* | Knowledge extraction pipeline |
| 018 | system_config | Encrypted config storage |

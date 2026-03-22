# Entity Archiving (Arweave Attestation)

On-demand snapshots of entity state, permanently stored on Arweave for third-party verification.

## How it works

Archiving is an explicit action, not automatic. A user (or agent) calls the archive endpoint, which:

1. Queries the full entity state at that moment
2. Computes a CID from the snapshot
3. Uploads the snapshot to Arweave
4. Logs an `entity_archived` activity entry with the CID and Arweave TX ID

No queue, no background workers. Volume is low enough to handle synchronously.

## Endpoint

```
POST /entities/:id/archive
```

Auth: owner or admin of the entity.

Response:
```json
{
  "cid": "bafy...",
  "arweave_tx": "abc123...",
  "ver": 7,
  "snapshot_at": "2026-03-21T15:30:00Z"
}
```

## What gets snapshotted

The snapshot captures everything needed to reconstruct the entity's state at that point in time:

### 1. Entity core

```sql
SELECT id, kind, type, ver, properties, owner_id,
       view_access, edit_access, contribute_access,
       edited_by, note, created_at, updated_at
FROM entities WHERE id = $id;
```

### 2. Outbound relationships

All relationships where this entity is the source (things it points to):

```sql
SELECT re.target_id, re.position, rel.type, rel.properties
FROM relationship_edges re
JOIN entities rel ON rel.id = re.id
WHERE re.source_id = $id;
```

### 3. Inbound relationships

All relationships where this entity is the target (things pointing at it):

```sql
SELECT re.source_id, re.position, rel.type, rel.properties
FROM relationship_edges re
JOIN entities rel ON rel.id = re.id
WHERE re.target_id = $id;
```

### 4. Access grants

```sql
SELECT actor_id, access_type, granted_at
FROM entity_access WHERE entity_id = $id;
```

## Snapshot document

The canonical JSON structure that gets CID'd and uploaded:

```json
{
  "schema": "arke-snapshot-v1",
  "entity": {
    "id": "01ABC...",
    "kind": "work",
    "type": "book",
    "ver": 7,
    "properties": { "label": "My Book", "..." : "..." },
    "owner_id": "01OWNER...",
    "view_access": "public",
    "edit_access": "collaborators",
    "contribute_access": "owner",
    "edited_by": "01EDITOR...",
    "note": "Final draft",
    "created_at": "2026-01-15T10:00:00Z",
    "updated_at": "2026-03-21T15:28:00Z"
  },
  "relationships_out": [
    {
      "relationship_id": "01REL...",
      "target_id": "01TGT...",
      "type": "cites",
      "properties": { "source_text": "p.42" },
      "position": null
    }
  ],
  "relationships_in": [
    {
      "relationship_id": "01REL...",
      "source_id": "01COMMONS...",
      "type": "contains",
      "properties": {},
      "position": 3
    }
  ],
  "access": [
    { "actor_id": "01ALICE...", "access_type": "edit", "granted_at": "2026-02-01T..." },
    { "actor_id": "01BOB...", "access_type": "admin", "granted_at": "2026-01-20T..." }
  ],
  "snapshot_at": "2026-03-21T15:30:00Z",
  "snapshot_by": "01ACTOR..."
}
```

Fields are sorted deterministically before CID computation so the same state always produces the same CID.

## Activity record

Each archive is logged as entity_activity:

```
action: "entity_archived"
detail: {
  cid: "bafy...",
  arweave_tx: "abc123...",
  ver: 7
}
```

This means:
- Archive history is queryable via the standard activity endpoint
- No separate attestation table needed
- The activity log is the index of all archives for an entity

## Verification

Anyone can verify an archived entity:

1. Get the archive activity entry (CID + Arweave TX)
2. Fetch the snapshot from Arweave using the TX ID
3. Recompute the CID from the fetched document
4. Compare — if they match, the snapshot is authentic

## Cross-reference with entity_versions

When archiving, the `cid` column on the current `entity_versions` row can optionally be backfilled:

```sql
UPDATE entity_versions SET cid = $computed_cid
WHERE entity_id = $id AND ver = $current_ver;
```

This links the content version to the full snapshot CID, but isn't required. The activity entry is the primary record.

## Why not automatic?

- Most entities don't need permanent attestation
- Arweave uploads cost money (AR tokens)
- Automatic per-version attestation generates noise — most intermediate versions aren't worth preserving permanently
- Users/agents choose what's worth archiving (final drafts, published works, important milestones)
- The ver + entity_versions table already provides full version history within the system

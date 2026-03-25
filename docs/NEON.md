# Neon Postgres Setup

How to set up, access, and manage the Neon database for arke-api.

---

## Authentication

```bash
npx neonctl@latest auth
```

Opens a browser for OAuth. Credentials are cached locally.

## Project

The test project lives under the Arkeon org:

| Field | Value |
|-------|-------|
| Name | `arke-api-test` |
| Project ID | `cool-feather-30976075` |
| Region | `aws-us-east-2` |
| Postgres | 17 |

### Connection strings

**Direct** (migrations, LISTEN/NOTIFY, long-lived connections):
```
postgresql://neondb_owner:<password>@ep-shy-mud-ajqu1oq7.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require
```

**Pooled** (Cloudflare Workers, serverless, short-lived connections):
```
postgresql://neondb_owner:<password>@ep-shy-mud-ajqu1oq7-pooler.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Always use the **pooled** connection for Workers. The direct connection is for migrations, schema changes, and any code using `LISTEN`/`NOTIFY`.

## Applying the schema

```bash
for f in schema/001-entities.sql schema/002-entity-access.sql schema/003-relationship-edges.sql schema/004-entity-versions.sql schema/005-entity-activity.sql schema/006-auth.sql schema/007-rls-policies.sql; do
  psql "$DATABASE_URL" -f "$f"
done
```

The `pg_cron` extension errors are expected — Neon requires cron jobs to be scheduled from the `postgres` database, not `neondb`. Set up pruning via the Neon console instead, or ignore it (activity pruning is non-critical).

## Running tests

```bash
psql "$DATABASE_URL" -f schema/tests/run_tests.sql
```

This creates a temporary `app_user` role, runs 62 tests (constraints, cascades, CAS, triggers, RLS), and prints a summary. All RLS tests run as `app_user` (non-superuser) to verify real permission enforcement.

## Database roles

| Role | Purpose | RLS |
|------|---------|-----|
| `neondb_owner` | Superuser. Migrations and schema changes only. | Bypassed |
| `app_user` | Application role. All runtime queries. | Enforced |

The Worker should connect as `app_user` (or an equivalent non-superuser role). Every request must set the actor identity at the start of a transaction:

```sql
-- Authenticated request
SET LOCAL app.actor_id = '01ACTOR...';

-- Unauthenticated request
SET LOCAL app.actor_id = '';
```

`SET LOCAL` is transaction-scoped — it resets when the transaction ends, so pooled connections don't leak identity between requests.

## Cloudflare Worker integration

### 1. Install the driver

```bash
npm install @neondatabase/serverless
```

### 2. Store the connection string

```bash
wrangler secret put DATABASE_URL
# paste the POOLED connection string
```

### 3. Use in code

```typescript
import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request: Request, env: Env) {
    const sql = neon(env.DATABASE_URL);

    // Set actor identity (RLS requires this)
    await sql`SELECT set_config('app.actor_id', ${actorId}, true)`;

    // Queries are now filtered by RLS automatically
    const entities = await sql`
      SELECT * FROM entities WHERE commons_id = ${commonsId}
    `;

    return Response.json(entities);
  }
};
```

`set_config(..., true)` is the function equivalent of `SET LOCAL` — it scopes the setting to the current transaction.

### 4. Transactions

For multi-statement transactions (CAS updates, creating entities + edges):

```typescript
import { neon } from '@neondatabase/serverless';

const sql = neon(env.DATABASE_URL);

// neon() executes each template as a single implicit transaction.
// For explicit multi-statement transactions, use the transaction helper:
const results = await sql.transaction([
  sql`SELECT set_config('app.actor_id', ${actorId}, true)`,
  sql`INSERT INTO entities (...) VALUES (...)`,
  sql`INSERT INTO relationship_edges (...) VALUES (...)`,
]);
```

## Neon-specific notes

### Connection pooling
Neon uses PgBouncer in transaction mode. This means:
- `SET LOCAL` works correctly (resets per transaction)
- `SET` (session-scoped) does NOT work — the setting persists across requests on the same pooled connection
- `LISTEN`/`NOTIFY` does NOT work through the pooler — use the direct connection for real-time subscriptions

### Autoscaling
The test project is configured with 0.25 CU min/max and auto-suspend at 0 seconds (suspends immediately when idle). First query after suspend takes ~500ms for cold start.

### Branching
Neon supports database branching (like git branches for your database). Useful for:
- Preview environments (one branch per PR)
- Testing migrations before applying to main
- Point-in-time recovery

```bash
# Create a branch
npx neonctl@latest branches create --name preview-123

# Get its connection string
npx neonctl@latest connection-string --branch preview-123
```

### pg_cron
Available but must be set up from the `postgres` database (not `neondb`). For activity pruning, either:
1. Connect to `postgres` and schedule the cron job there targeting `neondb`
2. Use an external scheduler (Cloudflare Cron Trigger, GitHub Actions)
3. Skip it — activity pruning is non-critical for development

## CLI quick reference

```bash
# Authenticate
npx neonctl@latest auth

# List projects
npx neonctl@latest projects list --org-id org-odd-heart-18500930

# Get connection string (direct)
npx neonctl@latest connection-string

# Get connection string (pooled)
npx neonctl@latest connection-string --pooled

# Create a branch
npx neonctl@latest branches create --name my-branch

# List branches
npx neonctl@latest branches list

# Delete a branch
npx neonctl@latest branches delete my-branch

# Run SQL directly
npx neonctl@latest sql "SELECT COUNT(*) FROM entities"
```

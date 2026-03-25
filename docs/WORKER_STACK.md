# Worker Stack & Implementation Plan

Cloudflare Worker implementation plan for `arke-api`.

## Stack

- **Runtime:** Cloudflare Workers
- **Router:** Hono
- **Database:** Neon Postgres via `@neondatabase/serverless`
- **Storage:** Cloudflare R2
- **Auth:** Ed25519 registration + API keys from the existing schema

## Why this stack

Hono matches the route-module shape already documented in `routes/`. Neon is the right fit for Workers because the pooled serverless driver works with short-lived requests and transaction-scoped RLS via `set_config(..., true)`. R2 is already the intended file backend.

## Database approach

- Use the **pooled** Neon connection string at runtime.
- Run the Worker as a non-superuser application role so RLS remains enforced.
- For each request transaction, set `app.actor_id` first.
- Use explicit transactions for all multi-statement mutations.

Typical transaction shape:

```ts
await sql.transaction([
  sql`SELECT set_config('app.actor_id', ${actorId ?? ''}, true)`,
  sql`...query 1...`,
  sql`...query 2...`,
]);
```

For write handlers that need conditional branching, use a transaction callback/helper rather than separate implicit queries.

## Route structure

- `src/index.ts` bootstraps the Hono app
- `src/middleware/auth.ts` resolves API keys and sets request actor context
- `src/middleware/db.ts` creates per-request DB helpers
- `src/routes/*.ts` mirrors the current route spec files
- `src/lib/queries/*` holds shared SQL builders for filters, pagination, and projections
- `src/lib/activity.ts` writes `entity_activity`
- `src/lib/notifications.ts` fans out inbox notifications via `ctx.executionCtx.waitUntil()`
- `src/lib/errors.ts` centralizes typed API errors

## Root commons

The root commons is a well-known row:

- `id = '00000000000000000000000000'`
- `kind = 'commons'`
- `type = 'commons'`
- `commons_id = NULL`

Startup should include an idempotent bootstrap check to ensure this row exists. This belongs in migration/bootstrap code, not in every request path.

## File handling

MVP should implement:

- `POST /entities/:id/content/upload-url`
- `POST /entities/:id/content/complete`
- `GET /entities/:id/content`
- `DELETE /entities/:id/content`
- `PATCH /entities/:id/content`

`POST /entities/:id/content` should remain documented as future work and return a clear not-implemented error if exposed before support exists.

## Query behavior

- `updated_at` changes only on content/version updates
- structural, access, comment, and relationship changes are tracked in `entity_activity`
- activity endpoints are intentionally public
- access configuration is readable by anyone who can view the entity

## Pagination and filtering

Implement one shared cursor utility and one shared filter parser:

- cursor payload: `{ t, i }` for timestamp-sorted listings
- field projections for `view=summary`, `view=full`, and `fields=...`
- parsed property filters compiled to parameterized SQL fragments

## Notification fan-out

After the main write transaction commits:

1. enqueue `fanOutNotifications(activityRow)` with `waitUntil`
2. open a new DB transaction
3. compute recipients from owner, grants, relationship target owner, commons owner, or grantee
4. batch-insert unique notification rows excluding self-actions

This keeps request latency bounded and matches the current schema docs.

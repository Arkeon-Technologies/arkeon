# Testing

Three levels: schema tests in Postgres, end-to-end API tests with Vitest, and opt-in stress scripts.

## E2E Test Layout

`packages/api/test/e2e/` — functional suite split by domain:

| File | Coverage |
|------|----------|
| `bootstrap.test.ts` | Health checks, basic auth, arke discovery |
| `actors.test.ts` | Actor creation, API key management |
| `classification.test.ts` | Classification-based access control |
| `entities-crud.test.ts` | Entity CRUD operations |
| `entity-permissions.test.ts` | Entity-level permissions |
| `groups.test.ts` | Group operations |
| `spaces.test.ts` | Space management |
| `workers.test.ts` | Worker/agent functionality |

## Stress Scripts

`packages/api/test/stress/` — manual operational checks, not part of Vitest:

- `auth.mjs` — auth flows under concurrency with retry/backoff
- `mutations.mjs` — repeated authenticated entity creation
- `search-scale.mjs` — search indexing and query load testing

## Schema Tests

Direct schema/RLS validation against Postgres:

```bash
psql "$DATABASE_URL" -f packages/schema/tests/run_tests.sql
```

# Testing

The Worker is tested at three levels:

- schema tests in Postgres
- end-to-end API tests with `vitest`
- opt-in stress/load scripts

## Commands

```bash
npm run typecheck
npm run test:e2e
npm run test:e2e:presigned
npm run stress:auth
npm run stress:mutations
```

## End-to-end layout

`test/e2e/` contains the functional suite, split by domain instead of one large
file:

- `health.test.ts`
- `auth.test.ts`
- `auth-negative.test.ts`
- `commons.test.ts`
- `entities-access.test.ts`
- `relationships-comments.test.ts`
- `content.test.ts`
- `search-inbox-activity.test.ts`
- `permissions-cas.test.ts`
- `concurrency.test.ts`
- `pagination.test.ts`

The default `npm run test:e2e` suite covers the implemented route surface
without requiring presigned-upload credentials.

`npm run test:e2e:presigned` enables the extra presigned content flow checks by
setting `E2E_PRESIGNED=1`.

## Stress scripts

`test/stress/` contains ad hoc load scripts:

- `auth.mjs` exercises challenge/register under concurrency with retry/backoff
- `mutations.mjs` exercises repeated authenticated entity creation

These are not part of the normal `vitest` run. They are meant for manual
operational checks and lightweight regression probing.

## Local vs deployed runs

By default the end-to-end suite targets the deployed Worker. To run against a
local instance, start `wrangler dev` and set `E2E_BASE_URL`, for example:

```bash
E2E_BASE_URL=http://127.0.0.1:8787 npm run test:e2e
```

## Database schema tests

For direct schema/RLS validation against Postgres:

```bash
psql "$DATABASE_URL" -f schema/tests/run_tests.sql
```

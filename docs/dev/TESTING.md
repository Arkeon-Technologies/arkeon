# Testing

Three levels: schema tests in Postgres, end-to-end API tests with Vitest, and opt-in stress scripts.

## E2E Test Layout

`packages/arkeon/test/e2e/` — functional suite split by domain:

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

## Manual Tests (LLM-dependent)

`packages/arkeon/test/manual/` — tests that require a running stack and a real LLM API key. Not run in CI.

| File | Coverage |
|------|----------|
| `knowledge-llm.test.ts` | Knowledge extraction permission inheritance (read_level, write_level, owner_id, grants) |

```bash
# Requires: running stack with --knowledge, OPENAI_API_KEY
ADMIN_BOOTSTRAP_KEY="..." OPENAI_API_KEY="sk-..." \
  npx vitest run --config vitest.manual.config.ts
```

**From a worktree**, use the main repo's vitest binary to avoid workspace path resolution issues:

```bash
ADMIN_BOOTSTRAP_KEY="..." OPENAI_API_KEY="sk-..." \
  /path/to/main/repo/node_modules/.bin/vitest run --config vitest.manual.config.ts
```

See [KNOWLEDGE_PIPELINE.md](./KNOWLEDGE_PIPELINE.md) for ad-hoc testing instructions.

## Stress Scripts

`packages/arkeon/test/stress/` — manual operational checks, not part of Vitest:

- `auth.mjs` — auth flows under concurrency with retry/backoff
- `mutations.mjs` — repeated authenticated entity creation
- `search-scale.mjs` — search indexing and query load testing

## Schema Tests

Direct schema/RLS validation against Postgres:

```bash
psql "$DATABASE_URL" -f packages/arkeon/src/schema/tests/run_tests.sql
```

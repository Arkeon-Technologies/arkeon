# arke

Monorepo for the Arke platform. npm workspaces with three packages:

- `packages/api` — Cloudflare Worker API (Hono + Neon Postgres + R2)
- `packages/cli` — CLI auto-generated from the API's OpenAPI spec
- `packages/schema` — Database migration SQL files

## Workspace Commands

```bash
npm run dev -w packages/api        # Start API dev server
npm run build -w packages/cli      # Build CLI
npm run typecheck -w packages/api  # Typecheck API
npm run test:e2e -w packages/api   # Run API e2e tests
```

## API: LLM Help System

The API has a layered, self-documenting help system served at `/llms.txt` and `/help`. It is the primary way LLMs discover and understand the API.

**When adding, modifying, or removing routes, you MUST update the route's `createRoute()` definition and Zod schemas.** OpenAPI is generated at runtime from the route definitions and powers all of:
- `/openapi.json`
- `/llms.txt`
- `/help/:method/:path`

Checklist for route changes:
- Define or update the route with `createRoute()` in the route file
- Reuse shared schemas from `packages/api/src/lib/schemas.ts` when possible
- Include `operationId`, `tags`, `summary`, `x-arke-auth`, and `x-arke-related`
- Use OpenAPI path params like `/{id}` in route metadata
- Keep summaries concise; put detail in parameter descriptions and schema descriptions
- Make request and response schemas accurate enough for CLI codegen and `/help` rendering

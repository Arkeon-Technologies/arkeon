# arke-api

Cloudflare Worker API built with Hono, backed by Neon Postgres and R2.

## LLM Help System

This API has a layered, self-documenting help system served at `/llms.txt` and `/help`. It is the primary way LLMs discover and understand the API.

**When adding, modifying, or removing routes, you MUST update the route's `createRoute()` definition and Zod schemas.** OpenAPI is generated at runtime from the route definitions and powers all of:
- `/openapi.json`
- `/llms.txt`
- `/help/:method/:path`

Checklist for route changes:
- Define or update the route with `createRoute()` in the route file
- Reuse shared schemas from `src/lib/schemas.ts` when possible
- Include `operationId`, `tags`, `summary`, `x-arke-auth`, and `x-arke-related`
- Use OpenAPI path params like `/{id}` in route metadata
- Keep summaries concise; put detail in parameter descriptions and schema descriptions
- Make request and response schemas accurate enough for CLI codegen and `/help` rendering

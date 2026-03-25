# arke-api

Cloudflare Worker API built with Hono, backed by Neon Postgres and R2.

## LLM Help System

This API has a layered, self-documenting help system served at `/llms.txt` and `/help`. It is the primary way LLMs discover and understand the API.

**When adding, modifying, or removing routes, you MUST update the corresponding `docs` export in the route file.** Each route file (e.g. `src/routes/entities.ts`) exports a `RouteDoc[]` array (e.g. `entityDocs`) that describes every endpoint in that file. These docs are registered in `src/app.ts` and served at runtime — there is no build step.

Checklist for route changes:
- Add/update the `RouteDoc` entry in the route file's `docs` export
- If adding a new route file, export its docs and register them in `src/app.ts` via `registerDocs()`
- Include: method, path, summary, auth level, params, body, response shape, notes, and related routes
- Keep summaries concise (one line) — detail goes in notes and param descriptions
- Mark required fields with `*` suffix in body/param keys (e.g. `"ver*": "number"`)
- Add `related` cross-references to help LLMs navigate between endpoints

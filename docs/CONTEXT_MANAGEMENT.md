# Context Management

How the platform communicates its capabilities to users, LLMs, and automated workers. This is the user experience layer — the thing that determines whether someone (or something) can actually use the API effectively.

## The Problem

An API with 75+ operations across 12 resource groups is useless if the caller doesn't know what's available. Human users can browse docs. LLM workers can't — they need the right context injected upfront, or they'll waste iterations guessing and failing.

Three audiences need to understand the same API, but through different lenses:

| Audience | Interface | Needs |
|----------|-----------|-------|
| Human via HTTP | API endpoints, curl, SDKs | Route index, parameter docs, guides |
| Human via CLI | `arkeon` commands | Command help, getting-started guide |
| LLM worker | Shell + tools in sandbox | Pre-loaded reference, discovery instructions |

## Architecture

### Shared Concepts (`packages/shared/`)

Single source of truth for "what things are." Zero-dependency package exporting named string constants:

- `WHAT_IS_ARKEON` — one-paragraph platform description
- `CORE_CONCEPTS` — Arke, Entity, Relationship, Space, Actor definitions
- `AUTHENTICATION` — header formats, key prefixes
- `CLASSIFICATION_LEVELS` — the 0-4 clearance system
- `BEST_PRACTICES` — connected graphs, relationships over properties
- `FILTERING_HINT` — filter syntax quick reference

These contain NO tool-specific examples — no HTTP requests, no CLI commands. Each consumer combines shared concepts with its own examples. Change a concept once in `packages/shared/src/concepts.ts`, and it propagates to the API guide, CLI guide, and worker prompts automatically.

### API Help System (`packages/api/`)

Layered discovery for HTTP consumers. All generated at runtime from route definitions + Zod schemas via `@hono/zod-openapi`.

**Endpoints:**

| Endpoint | Content | Source |
|----------|---------|--------|
| `GET /` | Entry point with links to all docs | Static |
| `GET /help` | Full route index with filter syntax | `renderIndexFromSpec()` from OpenAPI spec |
| `GET /help/guide` | Getting-started guide | Shared concepts + HTTP examples |
| `GET /help/guide/admin` | Admin operations guide | Static (admin-only content) |
| `GET /help/:method/:path` | Detailed docs for one route | `renderRouteHelpFromSpec()` from OpenAPI spec |
| `GET /llms.txt` | Machine-readable route index | Preamble + `renderIndexFromSpec()` |
| `GET /openapi.json` | Full OpenAPI 3.1.0 spec | `@hono/zod-openapi` |

**What's dynamic:** The route index and per-route help are generated from the OpenAPI spec, which is generated from `createRoute()` definitions and Zod schemas. Add a route, and it appears in `/help`, `/llms.txt`, and `/openapi.json` automatically.

**What's static:** The getting-started guide (`GENERAL_GUIDE`) combines shared concepts with hand-written HTTP workflow examples. The admin guide is fully static.

**Custom OpenAPI extensions** communicate intent to consumers:
- `x-arke-auth` — "required" or "optional" (shown in route index)
- `x-arke-rules` — permission/authorization rule descriptions (shown in detailed help)
- `x-arke-related` — cross-references to related routes (shown in detailed help)

### CLI Help System (`packages/cli/`)

Layered discovery for terminal users. Commands are auto-generated from the same OpenAPI spec.

**Help levels:**

```
arkeon --help                         # all command groups
arkeon <group> --help                 # commands in a group
arkeon <group> <command> --help       # full usage, params, auth, route
arkeon guide                          # getting-started guide with CLI examples
```

**Auto-generated commands** (75 operations, 12 groups) are created by `scripts/generate-commands.ts`, which parses the OpenAPI spec snapshot and produces `src/generated/index.ts`. Each command's help text includes parameter types, descriptions, auth requirements, and the underlying HTTP route.

**The CLI guide** (`arkeon guide`) uses shared concepts from `packages/shared/` combined with CLI-native workflow examples. It mirrors the API's getting-started guide but with `arkeon entities create ...` instead of `POST /entities { ... }`.

### Worker System Prompt (`packages/api/src/lib/worker-prompt.ts`)

The most critical context surface. Workers are LLMs running in sandboxes — their effectiveness is entirely determined by the quality of their starting context.

**Prompt structure:**

```
[User's custom system_prompt for this worker]

## Arkeon API — Quick Reference
  [Shared concepts from packages/shared/]
  [Classification levels]
  [Best practices]

## Tools
  ### Arkeon CLI
    [Usage examples]
    [IMPORTANT: --help discovery instructions]
  ### TypeScript SDK
    [Import pattern, common operations]
  ### Filtering
    [Filter syntax quick reference]

## API Route Index
  [Full route index — dynamically generated from OpenAPI at server startup]

## Environment
  [Sandbox details, pre-configured env vars]

## Invocation Nesting (if applicable)
  [Parent invocation context]
```

**What's dynamic:**
- Route index — generated once at server startup via `renderIndexFromSpec()`, stored via `setWorkerRouteIndex()`, injected into every worker prompt
- Shared concepts — imported from `packages/shared/`

**What's static (worker-specific):**
- CLI usage examples and `--help` discovery emphasis
- SDK import patterns
- Environment description
- Invocation nesting instructions

**The `--help` discovery callout** is deliberately prominent. The single biggest failure mode for workers is not knowing a command's exact syntax and guessing instead of checking. The prompt tells them: "If a command fails, ALWAYS run `--help` before retrying."

## Data Flow

```
Route definitions (createRoute + Zod)
        |
        v
  OpenAPI spec (runtime)
        |
        +---> /openapi.json
        +---> /help, /llms.txt (renderIndexFromSpec)
        +---> /help/:method/:path (renderRouteHelpFromSpec)
        +---> CLI commands (generate-commands.ts at build time)
        +---> Worker route index (setWorkerRouteIndex at startup)

Shared concepts (packages/shared/)
        |
        +---> API guide (/help/guide) + HTTP examples
        +---> CLI guide (arkeon guide) + CLI examples
        +---> Worker system prompt + route index + tool instructions
```

## Maintaining This System

**Adding a route:** Define it with `createRoute()` and Zod schemas. It automatically appears in `/help`, `/llms.txt`, `/openapi.json`, the worker route index, and CLI commands (after `npm run build -w packages/cli`).

**Changing a concept:** Edit `packages/shared/src/concepts.ts`. The API guide, CLI guide, and worker prompt all update automatically (API on next restart, CLI on next build).

**Changing workflow examples:** These are tool-specific and live in three places:
- API: `packages/api/src/routes/help.ts` (the `GENERAL_GUIDE` constant, HTTP examples section)
- CLI: `packages/cli/src/commands/guide/index.ts` (the `CLI_GUIDE` constant)
- Worker: `packages/api/src/lib/worker-prompt.ts` (CLI and SDK examples in `buildWorkerSystemPrompt`)

**Updating the route index for workers:** Happens automatically at server startup. No manual step required.

## Why This Matters

The difference between a worker that succeeds on the first try and one that burns 15 iterations fumbling is almost entirely about starting context. A well-informed worker:

1. Knows what operations exist (route index)
2. Knows how to execute them (CLI examples)
3. Knows how to recover when something fails (`--help` discovery)
4. Understands the domain model (shared concepts)
5. Follows platform conventions (best practices)

This system ensures all of that is in place before the worker's first tool call, without any manual context loading or discovery overhead.

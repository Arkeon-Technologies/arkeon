# Context Management

How the platform communicates its capabilities to users, LLMs, and automated workers. This is the user experience layer — the thing that determines whether someone (or something) can actually use the API effectively.

## The Problem

An API with 75+ operations across 12 resource groups is useless if the caller doesn't know what's available. Human users can browse docs. LLM workers can't — they need the right context injected upfront, or they'll waste iterations guessing and failing.

Four audiences need to understand the same API, but through different lenses:

| Audience | Interface | Needs |
|----------|-----------|-------|
| Human via HTTP | API endpoints, curl, SDKs | Route index, parameter docs, guides |
| Human via CLI | `arkeon` commands | Command help, getting-started guide |
| LLM worker | Shell + tools in sandbox | Complete reference — every command, parameter, response shape, and rule |
| Claude Code agent | Skills + CLI + HTTP | Skill instructions, `arkeon docs`, `arkeon guide` |

## Architecture

### Shared Operations (`packages/arkeon/src/shared/`)

Single source of truth for two concerns:

**Concepts** (`concepts.ts`): Named string constants defining what things are — `WHAT_IS_ARKEON`, `CORE_CONCEPTS`, `CLASSIFICATION_LEVELS`, `BEST_PRACTICES`, `FILTERING_HINT`. No tool-specific examples. Change a concept once and it propagates everywhere.

**CLI operations** (`cli-operations.ts`): The `OVERRIDES` map and `parseOperations()` function that parse an OpenAPI spec into structured `GeneratedOperation` objects. This is the single source of truth for how operationIds map to `arkeon <group> <action>` CLI commands, and how parameters, body fields, response schemas, and permission rules are extracted. Used by:
- CLI codegen script (generates Commander commands)
- Worker prompt (generates full CLI reference)
- `/llms.txt` (generates full API reference)

### API Help System (`packages/arkeon/src/server/`)

Layered discovery for HTTP consumers. All generated at runtime from route definitions + Zod schemas via `@hono/zod-openapi`.

**Endpoints:**

| Endpoint | Content | Source |
|----------|---------|--------|
| `GET /` | Entry point with links to all docs | Static |
| `GET /help` | Route summary index with filter syntax | `renderIndexFromSpec()` |
| `GET /help/guide` | Getting-started guide | Shared concepts + HTTP examples |
| `GET /help/guide/admin` | Admin operations guide | Static |
| `GET /help/:method/:path` | Detailed docs for one route | `renderRouteHelpFromSpec()` |
| `GET /llms.txt` | **Full API reference** — every route with all params, response shapes, rules | `renderFullApiReferenceFromSpec()` |
| `GET /openapi.json` | Full OpenAPI 3.1.0 spec | `@hono/zod-openapi` |

**`/llms.txt` is the primary LLM entry point.** It contains ~12K tokens with:
- SDK cheat sheets (TypeScript and Python) with import syntax, method signatures, configuration, error handling
- API response patterns (how responses wrap objects in named keys)
- Filter syntax reference with all operators and examples
- Complete API reference — every route with method, path, auth, parameters, request body, response schema, and permission rules

An LLM that reads `/llms.txt` once has everything it needs to use the API correctly via SDK or direct HTTP — no additional discovery calls needed.

**Custom OpenAPI extensions** communicate intent to consumers:
- `x-arke-auth` — "required" or "optional" (shown in route index)
- `x-arke-rules` — permission/authorization rule descriptions
- `x-arke-related` — cross-references to related routes

### CLI Help System (`packages/arkeon/src/cli/`)

Layered discovery for terminal users. Commands are auto-generated from the same OpenAPI spec using the shared `parseOperations()`.

**Help levels:**

```
arkeon --help                         # all command groups
arkeon <group> --help                 # commands in a group
arkeon <group> <command> --help       # full usage, params, auth, route
arkeon guide                          # getting-started guide with CLI examples
```

**Auto-generated commands** (~78 operations, 12 groups) are created by `scripts/generate-commands.ts`, which imports `parseOperations` from `src/shared/cli-operations.ts` and produces `src/generated/index.ts`.

**`arkeon docs` — offline complete reference:**

```
arkeon docs                # all formats combined (CLI + API + SDK)
arkeon docs --format cli   # CLI commands only (walks Commander tree)
arkeon docs --format api   # API reference (same content as /llms.txt, offline)
arkeon docs --format sdk   # SDK quick-reference
```

Built from the checked-in `spec/openapi.snapshot.json`, so it works without a running server. This is how Claude Code agents (and any offline tooling) get the full API reference without starting the stack.

### Skills (`packages/arkeon/assets/skills/`)

Claude Code skills are the primary AX surface for agents working *on* a knowledge graph (as opposed to workers running *inside* the sandbox).

**Source files:**
- `assets/skills/meta.yaml` — skill definitions with provider frontmatter (allowed tools, model settings)
- `assets/skills/body/*.md` — skill body content (arkeon-ingest, arkeon-connect, arkeon-doctor)
- `assets/skills/agents.md` — agent-facing quick reference bundled in Genesis seed

**Build pipeline:** `scripts/bundle-assets.ts` composes meta.yaml + body + provider frontmatter into complete skill files. Output lands in `src/generated/assets.ts`.

**Distribution:** `arkeon claude install` writes composed skills to `~/.claude/skills/`. An `arkeon:managed` comment lets the installer detect and update stale skills on version change.

**Key skills:**
- `arkeon-ingest` — initialize a repo and build a knowledge graph (4-phase protocol with parallel sub-agents)
- `arkeon-connect` — find and create relationships between entities across spaces
- `arkeon-doctor` — build, test, and publish the arkeon npm package

### Explorer (`packages/explorer/`)

Browser SPA for visual graph exploration, served at `GET /explore`. Built with Vite, bundled into `dist/explorer/` as part of the `arkeon` build, ships inside the npm tarball. Not a separate package — just a build artifact.

### Templates (`templates/`)

Starter configurations for common use cases (e.g., personal knowledge graph). Templates are not auto-generated — they're manually maintained markdown and config files that users copy as starting points.

### Worker System Prompt (`packages/arkeon/src/server/lib/worker-prompt.ts`)

The most critical context surface. Workers are LLMs running in sandboxes — their effectiveness is entirely determined by the quality of their starting context.

**Key principle: dump everything upfront.** Workers don't explore — they execute. The prompt includes the complete CLI reference with every command, every parameter, every type, and every rule. No "run `--help` to discover" — the details are inline.

**Prompt structure:**

```
[User's custom system_prompt for this worker]

## Arkeon API — Quick Reference
  [Shared concepts: what Arkeon is, core concepts, classification levels, best practices]

## Tools
  ### Arkeon CLI
    [Flag syntax, output format (default vs --raw), idempotency guidance]
  ### TypeScript SDK
    [Import, CRUD, pagination, relationships, errors, config (space_id)]
  ### API Response Patterns
    [CRITICAL: how responses wrap objects — entity.id not .id, relationship shapes, etc.]
  ### Filtering
    [Filter syntax quick reference]

## CLI Command Reference
  [COMPLETE reference — every command with all params, types, response shapes, rules]
  [Generated at startup from OpenAPI spec via renderFullReferenceFromSpec()]

## Environment
  [Pre-installed packages, pip install capability, system tools]
```

**What's dynamic:**
- CLI reference — generated at startup via `renderFullReferenceFromSpec()`, stored via `setWorkerCliReference()`. Uses `parseOperations()` from shared to get exact CLI command names, flag names, types, and descriptions.
- Shared concepts — imported from `packages/arkeon/src/shared/`

**What's static (worker-specific):**
- SDK examples and method signatures
- Response pattern documentation
- Output format documentation (default wrapper vs `--raw`)
- Idempotency guidance (avoid re-creating entities on retry)
- Environment description (pre-installed packages, pip install)

## Data Flow

```
Route definitions (createRoute + Zod)
        |
        v
  OpenAPI spec (runtime)
        |
        +---> /openapi.json
        +---> /help (renderIndexFromSpec — summary)
        +---> /llms.txt (renderFullApiReferenceFromSpec — complete)
        +---> /help/:method/:path (renderRouteHelpFromSpec — per-route)
        +---> CLI commands (parseOperations at build time)
        +---> Worker CLI reference (renderFullReferenceFromSpec at startup)
        +---> arkeon docs --format api (offline, from snapshot)

Shared concepts (packages/arkeon/src/shared/concepts.ts)
        |
        +---> API guide (/help/guide) + HTTP examples
        +---> CLI guide (arkeon guide) + CLI examples
        +---> Worker system prompt

Shared operations (packages/arkeon/src/shared/cli-operations.ts)
        |
        +---> CLI codegen (generate-commands.ts)
        +---> Worker prompt (renderFullReferenceFromSpec)
        +---> /llms.txt (renderFullApiReferenceFromSpec)

Skill sources (assets/skills/meta.yaml + body/*.md)
        |
        +---> bundle-assets.ts
        +---> src/generated/assets.ts
        +---> arkeon claude install → ~/.claude/skills/

Explorer SPA (packages/explorer/)
        |
        +---> Vite build
        +---> dist/explorer/ → GET /explore
```

## Maintaining This System

**Adding a route:** Define it with `createRoute()` and Zod schemas. It automatically appears in `/help`, `/llms.txt`, `/openapi.json`, the worker CLI reference, and CLI commands (after `npm run build -w packages/arkeon`). If the route needs a non-default CLI group/action mapping, add an entry to `CLI_OVERRIDES` in `packages/arkeon/src/shared/cli-operations.ts`.

**Changing a concept:** Edit `packages/arkeon/src/shared/concepts.ts`. The API guide, CLI guide, and worker prompt all update automatically.

**Changing SDK examples:** Edit `packages/arkeon/src/server/lib/worker-prompt.ts` (worker) and the `FILTER_SYNTAX_BLOCK` preamble in `packages/arkeon/src/server/lib/openapi-help.ts` (`/llms.txt`).

**Updating the route index for workers:** Happens automatically at server startup. No manual step required.

**Changing a skill:** Edit `assets/skills/meta.yaml` (metadata/frontmatter) or `assets/skills/body/*.md` (content). Rebuild (`npm run build -w packages/arkeon`) to regenerate `src/generated/assets.ts`. Users pick up changes on next `arkeon claude install` or automatically on version change.

**Adding a new skill:** Add the skill definition to `meta.yaml` and its body to `body/<name>.md`. The build pipeline handles composition and distribution.

**Updating `arkeon docs` output:** Happens automatically when the OpenAPI snapshot is regenerated. No separate step.

## Complete Surface Map

Quick reference for where each audience gets context:

| Surface | Audience | Auto-generated? | Source of truth |
|---------|----------|-----------------|-----------------|
| `GET /llms.txt` | External LLMs, SDK users | Yes (runtime) | Route definitions + Zod schemas |
| `GET /help` | HTTP users | Yes (runtime) | Route definitions |
| `GET /help/guide` | HTTP users | Partial (concepts auto, examples manual) | `concepts.ts` + `help.ts` |
| `GET /openapi.json` | Tool builders | Yes (runtime) | Route definitions |
| `arkeon docs` | CLI users, offline agents | Yes (build-time) | OpenAPI snapshot |
| `arkeon guide` | CLI users | Partial | `concepts.ts` + `guide/index.ts` |
| `arkeon <cmd> --help` | CLI users | Yes (build-time) | OpenAPI snapshot |
| Worker system prompt | Sandbox LLM workers | Yes (startup) | OpenAPI + `concepts.ts` + `worker-prompt.ts` |
| Skills | Claude Code agents | Yes (build-time) | `assets/skills/meta.yaml` + `body/*.md` |
| Explorer | Browser users | Yes (build-time) | `packages/explorer/` |
| Templates | New users | No (manual) | `templates/` |

## Why This Matters

The difference between a worker that succeeds in 2 iterations and one that burns 15 is almost entirely about starting context. Testing showed:

| Context quality | Iterations for same task | Duplicates |
|----------------|--------------------------|------------|
| Summary index + "use --help" | 12 | Yes (7 entities instead of 3) |
| Full reference + response patterns | 2 | None |

A well-informed worker:

1. Knows every operation and its exact syntax (full CLI reference)
2. Knows what comes back (response patterns — `entity.id`, not `.id`)
3. Knows how to avoid mistakes (idempotency guidance, `--raw` for piping)
4. Understands the domain model (shared concepts)
5. Can install additional tools when needed (`pip install` works)
6. Can see images when the LLM supports it (`view_image` tool)

// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";

import {
  WHAT_IS_ARKEON,
  CORE_CONCEPTS,
  AUTHENTICATION,
  BEST_PRACTICES,
} from "@arkeon-technologies/shared";
import {
  renderIndexFromSpec,
  renderPreamble,
  renderRouteHelpFromSpec,
  renderRouteNotFoundFromSpec,
} from "../lib/openapi-help";
import { requireAdmin } from "../lib/http";
import type { AppBindings } from "../types";

const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
};

// ---------------------------------------------------------------------------
// Guide content
// ---------------------------------------------------------------------------

export const GENERAL_GUIDE = `# Arkeon — Getting Started

## What is Arkeon?

${WHAT_IS_ARKEON}

## Core Concepts

${CORE_CONCEPTS}

## Authentication

${AUTHENTICATION}

The route index (GET /help) shows each route's auth requirement.

## Your First Workflow

1. Create an entity
   POST /entities
   {
     "type": "note",
     "properties": { "title": "Hello", "body": "My first entity." }
   }
2. List entities
   GET /entities

3. Create a relationship
   POST /entities/{sourceId}/relationships
   {
     "predicate": "references",
     "target_id": "<entity B>",
     "properties": { "label": "references" }
   }

4. Search
   GET /search?q=hello

## Working Within a Space

Spaces are organizational containers with their own access controls. You can
add an entity to a space and grant permissions in the same call that creates it:

   POST /entities
   {
     "type": "note",
     "properties": { "title": "Hello" },
     "space_id": "<space ULID>",
     "permissions": [
       { "grantee_type": "actor", "grantee_id": "<actor ULID>", "role": "editor" }
     ]
   }

This is atomic — if any part fails (e.g. you lack contributor access on the
space), nothing is created. The same space_id and permissions fields work on
relationship creation (POST /entities/{id}/relationships).

You can still add entities to spaces and grant permissions separately:
   POST /spaces/{id}/entities          — add existing entity to space
   POST /entities/{id}/permissions     — grant permissions on existing entity

## Filtering

Any listing endpoint supports the filter query param. The full syntax
(operators, column names, property paths) is documented at the top of the
route index — run GET /help to see it.

## Best Practices

${BEST_PRACTICES}

## Tools

Beyond direct HTTP calls, Arkeon provides a CLI and a TypeScript SDK that handle
authentication and pagination for you.

### CLI

Install:  npm install -g arkeon
Config:   export ARKE_API_URL=https://<your-instance>.arkeon.tech
          export ARKE_API_KEY=<your-api-key>
Usage:    arkeon entities list
          arkeon entities create --type note --properties '{"title":"Hello"}'
          arkeon search --q hello
          arkeon --help

The CLI is auto-generated from the API's OpenAPI spec, so every route is
available as a command. Use --help on any command for full options.

### SDK

Install:    npm install @arkeon-technologies/sdk
Usage:      import { ArkeonClient } from '@arkeon-technologies/sdk';
            const client = new ArkeonClient();
            await client.get('/entities');

The SDK reads ARKE_API_URL and ARKE_API_KEY from the environment and handles
authentication, pagination, and error handling automatically.

## Getting More Help

GET /help                         Full route index with auth & summary
GET /help/GET/entities/{id}       Detailed docs for any specific route
GET /llms.txt                     Machine-readable route index
`;

const ADMIN_GUIDE = `# Arkeon — Admin Guide

This guide covers operations that require admin privileges.

## What Admins Can Do

- Create and manage networks, actors, and API keys
- Configure and invoke workers (LLM agents)
- Set classification levels on content
- Rebuild search indexes
- View instance-wide statistics

## Managing Actors

Create an actor:
  POST /actors
  {
    "kind": "agent",
    "properties": { "label": "Researcher" },
    "max_read_level": 2,
    "max_write_level": 2
  }

Generate an API key for them:
  POST /actors/{id}/keys

Actors come in two kinds:
  agent   interactive use (human, bot, CLI)
  worker  automated — runs sandboxed code with LLM backing

## Classification Levels

Arkeon uses integer clearance levels (0-4) to control access:

  0  PUBLIC        readable by anyone, including unauthenticated
  1  INTERNAL      readable by any authenticated actor
  2  TEAM          requires TEAM clearance or above
  3  CONFIDENTIAL  requires CONFIDENTIAL clearance or above
  4  RESTRICTED    highly restricted

Entities have read_level and write_level.
Actors have max_read_level and max_write_level.

Rule: an actor can only read entities where
  entity.read_level <= actor.max_read_level
and only write where
  entity.write_level <= actor.max_write_level

## Workers

Workers are actors with kind "worker". They run sandboxed code with LLM
backing and have access to the Arke API via environment variables.

Configure a worker:
  POST /actors
  {
    "kind": "worker",
    "properties": {
      "name": "observer",
      "system_prompt": "You are an observer...",
      "llm": { "model": "...", "base_url": "...", "api_key": "..." },
      "schedule": "0 * * * *",
      "max_iterations": 50
    }
  }

Workers automatically receive ARKE_API_URL and ARKE_API_KEY in their
environment. Invoke manually:
  POST /workers/{id}/invoke
  { "prompt": "..." }

View invocation history:
  GET /workers/{id}/invocations

## Spaces & Permissions

Create a space:
  POST /spaces
  { "name": "Design Review" }

Spaces have their own read_level/write_level defaults. Assign roles to
actors within spaces to scope access.

Add an entity to a space:
  POST /spaces/{id}/entities
  { "entity_id": "<id>" }

## Admin Endpoints

GET  /admin/stats             entity count, actor count, DB size, etc.
POST /admin/reindex           rebuild the Meilisearch full-text index
GET  /admin/instance          instance metadata
PUT  /admin/actors/{id}       update actor fields directly

## Best Practices

Organize with spaces.
  Spaces are like directories for your knowledge graph. Create a space for
  each project, domain, or workstream and assign entities to it. Most entities
  should live in at least one space — ungrouped entities become hard to manage
  as the graph grows. Spaces can be nested, so you can build a hierarchy
  that mirrors your organization (e.g., "Engineering" > "Backend" > "API v2").

Encourage connected graphs.
  Set the expectation that entities should be linked via relationships rather
  than left as isolated nodes. The value of the graph compounds with
  connectivity — isolated entities are just a database.

## Next Steps

See GET /help for the full route index.
See GET /help/<METHOD>/<path> for detailed docs on any route.
`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createHelpRouter(getSpec: () => { paths?: Record<string, unknown> }) {
  const helpRouter = new Hono<AppBindings>();

  helpRouter.get("/guide/admin", (c) => {
    requireAdmin(c);
    return c.text(ADMIN_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/guide", (c) => {
    return c.text(GENERAL_GUIDE, 200, TEXT_HEADERS);
  });

  helpRouter.get("/", (c) => {
    return c.text(renderIndexFromSpec(getSpec()), 200, TEXT_HEADERS);
  });

  helpRouter.get("/:method/:path{.+}", (c) => {
    const method = c.req.param("method").toUpperCase();
    const path = `/${c.req.param("path")}`;
    const body = renderRouteHelpFromSpec(getSpec(), method, path);
    if (!body) {
      return c.text(renderRouteNotFoundFromSpec(getSpec(), method, path), 404, TEXT_HEADERS);
    }
    return c.text(body, 200, TEXT_HEADERS);
  });

  return helpRouter;
}

import { Hono } from "hono";

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

const GENERAL_GUIDE = `# Arkeon — Getting Started

## What is Arkeon?

Arkeon is a knowledge graph API. You store entities (nodes) and relationships
(edges) in isolated networks. Everything is versioned, permissioned, and
searchable.

## Core Concepts

Arke (Network)
  An isolated workspace. Actors belong to an arke — their data is automatically
  scoped to it. Admins can operate across arkes. List arkes with GET /arkes.

Entity
  The fundamental data unit. Every entity has:
  - kind     "entity" or "relationship"
  - type     freeform semantic type (person, book, observation — your choice)
  - properties   JSON object for your data (label, body, metadata, etc.)
  Entities are versioned, commentable, and access-controlled.

Relationship
  A typed, directed edge between two entities. Relationships are themselves
  entities (kind: "relationship"), so they carry properties, versions, and
  comments just like any other entity.

Space
  An organizational container with its own access controls. Assign entities to
  spaces and grant actors roles within them.

Actor
  An authenticated identity — you. Actors can be agents (interactive) or
  workers (scheduled/automated). Each actor has API keys and clearance levels.

## Authentication

Pass your API key via header:
  X-API-Key: <key>           (preferred)
  Authorization: ApiKey <key>

Key prefixes indicate type:
  uk_  user key
  kk_  klados key

Some routes are public; most require auth. The route index (GET /help) shows
each route's auth requirement.

## Your First Workflow

1. Create an entity
   POST /entities
   {
     "type": "note",
     "properties": { "title": "Hello", "body": "My first entity." }
   }
   Your arke_id is automatically set from your actor's membership.
   Admin actors must pass arke_id explicitly.

2. List entities
   GET /entities
   Results are automatically scoped to your arke.

3. Create a relationship
   POST /entities/{sourceId}/relationships
   {
     "predicate": "references",
     "target_id": "<entity B>",
     "properties": { "label": "references" }
   }

4. Search
   GET /search?q=hello

## Filtering

Any listing endpoint supports the filter query param. The full syntax
(operators, column names, property paths) is documented at the top of the
route index — run GET /help to see it.

## Best Practices

Build a connected graph.
  Every entity should be connected to at least one other entity through a
  relationship. Isolated nodes are hard to discover and lose context. A good
  habit: when you create an entity, immediately create a relationship linking
  it to whatever prompted its creation — cite your sources.

Use relationships, not properties, for references.
  If entity A references entity B, create a relationship between them rather
  than storing B's ID inside A's properties. Relationships are first-class:
  they're searchable, permissioned, and visible in the graph. A property
  value is just opaque text.

Relationships are entities too.
  Because relationships are full entities (kind: "relationship"), they can
  carry their own properties, versions, and comments — and other entities can
  relate to them. This means you can cite a relationship, annotate it, or
  build second-order structure (e.g., "this claim is supported by that
  relationship").

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

## Managing Networks

Create a network:
  POST /arkes
  { "name": "Research", "description": "..." }

Each network has default read/write levels that new entities inherit:
  default_read_level   (0-4, default 1)
  default_write_level  (0-4, default 1)

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
  as the network grows. Spaces can be nested, so you can build a hierarchy
  that mirrors your organization (e.g., "Engineering" > "Backend" > "API v2").

Encourage connected graphs.
  When creating arkes and onboarding actors, set the expectation that entities
  should be linked via relationships rather than left as isolated nodes. The
  value of the graph compounds with connectivity — isolated entities are just
  a database.

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

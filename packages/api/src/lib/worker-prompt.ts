/**
 * Builds the full system prompt for worker invocations.
 *
 * Concept text comes from arkeon-shared (single source of truth).
 * The route index is generated once at server startup (via setWorkerRouteIndex)
 * and injected so workers have a complete picture of the API from the first tool call.
 */

import {
  WHAT_IS_ARKEON,
  CORE_CONCEPTS,
  CLASSIFICATION_LEVELS,
  BEST_PRACTICES,
  FILTERING_HINT,
} from "arkeon-shared";

import type { InvocationContext } from "./worker-invoke.js";

// ---------------------------------------------------------------------------
// Route index — set once at startup from the OpenAPI spec
// ---------------------------------------------------------------------------

let routeIndex: string | null = null;

export function setWorkerRouteIndex(index: string): void {
  routeIndex = index;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

export function buildWorkerSystemPrompt(
  userSystemPrompt: string,
  context?: InvocationContext,
): string {
  const sections: string[] = [
    userSystemPrompt,
    "",
    "## Arkeon API — Quick Reference",
    "",
    "### What is Arkeon?",
    WHAT_IS_ARKEON,
    "",
    "### Core Concepts",
    CORE_CONCEPTS,
    "",
    "### Classification Levels",
    CLASSIFICATION_LEVELS,
    "",
    "### Best Practices",
    BEST_PRACTICES,
    "",

    // ----- Tools: CLI -----
    "## Tools",
    "",
    "### Arkeon CLI (recommended for most tasks)",
    "The `arkeon` CLI is pre-installed and pre-authenticated. Use it for one-off commands.",
    "",
    "Examples:",
    "  arkeon entities list                                        # list entities",
    "  arkeon entities create --type note --body-field properties.label 'My note'",
    "  arkeon entities get <id>                                    # fetch by ID",
    "  arkeon search query --q 'search terms'                     # full-text search",
    "  arkeon relationships list --source-id <id>                  # outgoing edges",
    "  arkeon workers invoke <id> --body-field prompt 'do something'",
    "",
    "IMPORTANT — Discovering commands:",
    "  arkeon --help                        # list ALL command groups",
    "  arkeon <group> --help                # list commands in a group",
    "  arkeon <group> <command> --help      # full usage, params, and route info",
    "",
    "If a command fails or you're unsure of the syntax, ALWAYS run --help for that",
    "command before retrying. The help output shows every parameter, its type, and",
    "whether it's required. This is faster and more reliable than guessing.",
    "",

    // ----- Tools: SDK -----
    "### TypeScript SDK (for bulk or scripted operations)",
    "Write a short Node.js script. The SDK (@arkeon-technologies/sdk) is pre-installed with zero config.",
    "",
    "  import { ArkeonClient } from '@arkeon-technologies/sdk';",
    "  const client = new ArkeonClient();",
    "  const items = await client.get('/entities', { params: { type: 'note' } });",
    "  await client.post('/entities', { type: 'note', properties: { label: 'Hello' } });",
    "",
    "As a last resort, use curl + jq — but prefer the CLI or SDK as they handle auth and errors automatically.",
    "",

    // ----- Filtering -----
    "### Filtering",
    FILTERING_HINT,
    "",

    // ----- Route index -----
    "## API Route Index",
    "Below is the complete list of API routes. Use this to know what's available.",
    "For detailed docs on any route, run: arkeon <group> <command> --help",
    "Or fetch: curl -s -H \"X-API-Key: $ARKE_API_KEY\" $ARKE_API_URL/help/GET/entities/{id}",
    "",
  ];

  // Inject route index if available (generated at startup from OpenAPI spec)
  if (routeIndex) {
    sections.push(routeIndex);
  } else {
    sections.push(
      "Route index not available. Run `arkeon --help` to discover all commands.",
    );
  }

  sections.push(
    "",
    "## Environment",
    "You are running in an isolated sandbox with a writable workspace directory.",
    "$ARKE_API_URL and $ARKE_API_KEY are pre-configured for the CLI and SDKs.",
  );

  // Invocation nesting context
  if (context) {
    sections.push(
      "",
      "## Invocation Nesting",
      `$ARKE_INVOCATION_ID=${context.invocationId} and $ARKE_INVOCATION_DEPTH=${context.depth} track nesting.`,
      "When invoking other workers, pass these headers:",
      "  -H 'X-Arke-Parent-Invocation: $ARKE_INVOCATION_ID' -H 'X-Arke-Invocation-Depth: $ARKE_INVOCATION_DEPTH'",
    );
  }

  sections.push(
    "",
    "When done, call the done tool with a structured result summarizing what you accomplished.",
  );

  return sections.join("\n");
}

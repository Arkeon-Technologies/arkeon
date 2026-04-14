// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the full system prompt for worker invocations.
 *
 * Concept text comes from ../../shared (single source of truth).
 * The CLI reference is generated once at server startup from the OpenAPI spec
 * and injected so workers have complete tool knowledge from the first call.
 */

import {
  WHAT_IS_ARKEON,
  CORE_CONCEPTS,
  CLASSIFICATION_LEVELS,
  BEST_PRACTICES,
  FILTERING_HINT,
} from "../../shared/index.js";

import type { InvocationContext } from "./worker-invoke.js";

// ---------------------------------------------------------------------------
// Generated at startup from the OpenAPI spec
// ---------------------------------------------------------------------------

let cliReference: string | null = null;

export function setWorkerCliReference(reference: string): void {
  cliReference = reference;
}

// Keep backward-compat alias for existing callers
export const setWorkerRouteIndex = setWorkerCliReference;

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

    // ----- Tools overview -----
    "## Tools",
    "",
    "### Arkeon CLI (recommended for most tasks)",
    "The `arkeon` CLI is pre-installed and pre-authenticated.",
    "",
    "Flag syntax:",
    "  - String/number flags: --flag-name <value>",
    "  - JSON object/array flags: --flag-name '{\"key\":\"value\"}' or --flag-name @file.json",
    "  - Required flags are marked with * in the reference below",
    "  - You can also pass the entire request body with: --data '{...}' or --data @file.json",
    "  - Do NOT combine individual flags with --data for the same fields (double-submit)",
    "",
    "Output format:",
    "  Default output wraps the API response: { ok, operation, method, path, data: <api_response> }",
    "  Use --raw to get the bare API response (recommended when piping to jq).",
    "  Example: arkeon entities create --type note --properties '{...}' --raw | jq '.entity.id'",
    "",
    "If a command fails, run `arkeon <group> <command> --help` for the full usage.",
    "",
    "IMPORTANT — Avoiding duplicates:",
    "  API creates are NOT idempotent. If you create entities in a script and the script",
    "  fails partway through, do NOT re-run the entire script. Instead:",
    "  1. Save created IDs to a file (e.g. echo $id >> ids.txt) as you go",
    "  2. On retry, read the file to see what was already created",
    "  3. Only create what's missing",
    "  Or: create each entity in a separate shell command so you can retry individually.",
    "",

    // ----- Tools: SDK -----
    "### TypeScript SDK (for bulk or scripted operations)",
    "Write a short Node.js script. The SDK (@arkeon-technologies/sdk) is pre-installed with zero config.",
    "Auth is automatic from $ARKE_API_URL and $ARKE_API_KEY env vars.",
    "",
    "  import * as arkeon from '@arkeon-technologies/sdk';",
    "",
    "  // HTTP methods — paths match the API reference below",
    "  await arkeon.get('/entities', { params: { filter: 'type:note' } });",
    "  await arkeon.post('/entities', { type: 'note', properties: { label: 'Hello' } });",
    "  await arkeon.put(`/entities/${id}`, { ver: 1, properties: { label: 'Updated' } });",
    "  await arkeon.del(`/entities/${id}`);",
    "",
    "  // Pagination — async generator, yields individual items across all pages",
    "  for await (const entity of arkeon.paginate('/entities', { limit: '50' })) {",
    "    console.log(entity.id);",
    "  }",
    "",
    "  // Relationships — source entity in path, target in body",
    "  await arkeon.post(`/entities/${sourceId}/relationships`, {",
    "    predicate: 'references',",
    "    target_id: targetId,",
    "  });",
    "",
    "  // Error handling",
    "  import { ArkeError } from '@arkeon-technologies/sdk';",
    "  try { ... } catch (e) {",
    "    if (e instanceof ArkeError) console.log(e.status, e.code, e.requestId);",
    "  }",
    "",
    "Notes:",
    "  - get(path, { params }) / post(path, body) / put(path, body) / del(path)  [del, not delete]",
    "  - put/patch require `ver` in body (optimistic concurrency — 409 if stale)",
    "  - space_id auto-injected from $ARKE_SPACE_ID env; or setSpaceId(id)",
    "  - All paths match the API reference in this document",
    "",
    "As a last resort, use curl + jq — but prefer the CLI or SDK as they handle auth and errors automatically.",
    "",

    // ----- Response note -----
    "### API Responses",
    "IMPORTANT: API responses wrap objects in a named key — see the Response section on each command below.",
    "  Never access .id directly on the response; always use the wrapper key first (e.g., resp.entity.id, resp.results).",
    "",

    // ----- Filtering -----
    "### Filtering",
    FILTERING_HINT,
    "",

    // ----- Full CLI reference -----
    "## CLI Command Reference",
    "Complete reference for every CLI command with all parameters, types, and rules.",
    "",
  ];

  if (cliReference) {
    sections.push(cliReference);
  } else {
    sections.push(
      "CLI reference not available. Run `arkeon --help` to discover all commands,",
      "and `arkeon <group> <command> --help` for detailed usage.",
    );
  }

  sections.push(
    "",
    "## Environment",
    "You are running in an isolated sandbox with a writable workspace directory.",
    "$ARKE_API_URL and $ARKE_API_KEY are pre-configured for the CLI and SDKs.",
    "$ARKE_DONE_FILE is the file where you must write your final JSON result.",
    "The `arke-done` shell command is pre-installed. Run it after writing $ARKE_DONE_FILE to finish the task.",
    "",
    "Pre-installed Python packages:",
    "  reportlab, pypdf, python-docx, openpyxl, python-pptx (Office docs)",
    "  ebooklib, beautifulsoup4, lxml (EPUB, HTML, XML)",
    "  Pillow (images), pandas (data), markdown, chardet",
    "",
    "Need something else? `pip install <package>` works — packages install to your workspace.",
    "No --target or --break-system-packages flags needed (pre-configured).",
    "",
    "System tools: python/python3, node, curl, jq, bash",
  );

  sections.push(
    "",
    "## Important: No Browser Access",
    "You do NOT have a browser and CANNOT open URLs or display web pages.",
    "To show the user entities visually, construct an explore URL and include it in the JSON you write to $ARKE_DONE_FILE:",
    "  https://app.arkeon.tech/explore?instance=$ARKE_API_URL&entity=<entityId>",
    "The calling agent or user can open this URL in their browser.",
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
    "## Returning Results (CRITICAL)",
    "Your final structured result MUST be written as a JSON object to $ARKE_DONE_FILE.",
    "Then you MUST run the `arke-done` shell command to signal completion.",
    "",
    "Do NOT return JSON as a text response or in a markdown code block.",
    "Do NOT print or echo done(...). Do NOT put the final result only in stdout.",
    "The ONLY way to complete a task is: write $ARKE_DONE_FILE, then run arke-done.",
    "If you skip this, your work is lost and the invocation is marked as failed.",
    "",
    "You may use shell, Python, or Node to write the file.",
    "Examples:",
    "  jq -n '{\"message\":\"done\"}' > \"$ARKE_DONE_FILE\" && arke-done",
    "  python3 - <<'PY'",
    "  import json, os",
    "  with open(os.environ['ARKE_DONE_FILE'], 'w') as f:",
    "      json.dump({\"message\": \"done\"}, f)",
    "  PY",
    "  arke-done",
    "",
    "When your result includes entity or relationship IDs from the graph,",
    "make sure to capture relationship IDs (from list-relationships output)",
    "in addition to entity IDs. Both are needed for downstream analysis.",
  );

  return sections.join("\n");
}

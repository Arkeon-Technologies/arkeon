import type { Actor } from "../types";

export function renderPreamble(actor: Actor | null): string {
  const lines: string[] = [];

  if (!actor) {
    lines.push("# Arkeon API");
    lines.push("#");
    lines.push("# Authenticate with X-API-Key: <key> to see personalized guidance.");
    lines.push("# See GET /help/guide for a getting-started walkthrough.");
    lines.push("");
    return lines.join("\n");
  }

  const name = actor.label ?? actor.keyPrefix;
  lines.push(`# Arkeon API`);
  lines.push(`#`);
  lines.push(`# You are authenticated as: ${name}`);
  lines.push(`# Clearance: read=${actor.maxReadLevel} write=${actor.maxWriteLevel}`);
  lines.push(`#`);
  lines.push(`# New here? See GET /help/guide for a getting-started walkthrough.`);

  if (actor.isAdmin) {
    lines.push(`# Admin? See GET /help/guide/admin for network setup, actors, workers, and classification.`);
  }

  lines.push("");
  return lines.join("\n");
}

const FILTER_SYNTAX_BLOCK = [
  "# Arkeon API — Route Index",
  "# Auth: X-API-Key: <key> (preferred) or Authorization: ApiKey <key> — prefixes uk_ (user) or kk_ (klados)",
  "# Detail: GET /help/<METHOD>/<path> for full docs on any route",
  "# Example: GET /help/GET/entities/{id}",
  "#",
  "# Tip: Many routes require a network_id. If using the Arkeon CLI, run",
  "# `arkeon config set-network <ULID>` to set a default so you don't need",
  "# --network-id on every command. Env var ARKE_NETWORK_ID also works.",
  "#",
  "# SDKs: Pre-authenticated wrappers read ARKE_API_URL and ARKE_API_KEY from env.",
  "#   TypeScript: import * as arkeon from 'arkeon-sdk'; await arkeon.get('/entities')",
  "#   Python:     import arkeon_sdk as arkeon; arkeon.get('/entities')",
  "",
  "## Filter Syntax",
  "# Use the `filter` query param on any listing endpoint.",
  "# Format: filter=field<op>value,field<op>value (comma-separated, AND'd)",
  "#",
  "# Operators:",
  "#   :   equals         kind:entity",
  "#   !:  not equals     kind!:relationship",
  "#   >   greater than   created_at>2026-01-01",
  "#   >=  greater/equal  ver>=2",
  "#   <   less than      updated_at<2026-06-01",
  "#   <=  less/equal     ver<=5",
  "#   ?   exists         label?",
  "#   !?  missing        description!?",
  "#",
  "# Entity columns (filter directly on the schema):",
  "#   kind            text       entity | relationship",
  "#   type            text       semantic type (book, person, etc.)",
  "#   network_id      text       arke (network) ULID",
  "#   ver             numeric    content version number",
  "#   owner_id        text       owner actor ULID",
  "#   read_level      numeric    classification level (0-4)",
  "#   write_level     numeric    write ceiling (0-4)",
  "#   edited_by       text       last editor ULID",
  "#   created_at      timestamp  ISO 8601",
  "#   updated_at      timestamp  ISO 8601",
  "#",
  "# Property paths (filter on properties JSONB):",
  "#   label:Neuroscience          exact match on properties.label",
  "#   metadata.source:arxiv       nested path",
  "#   year>2020                   numeric comparison (non-column paths)",
  "#",
  "# Examples:",
  "#   filter=kind:entity,type:book,created_at>2026-01-01",
  "#   filter=owner_id:01ABC,read_level<=2",
  "#   filter=kind!:relationship,language:English",
  "",
];

type OpenAPISpec = {
  components?: {
    schemas?: Record<string, unknown>;
  };
  paths?: Record<string, unknown>;
};

type OperationMatch = {
  method: string;
  path: string;
  operation: Record<string, unknown>;
};

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

function resolveSchema(spec: OpenAPISpec, schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined;
  }
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const name = ref.split("/").pop() ?? "";
    return resolveSchema(spec, spec.components?.schemas?.[name] as Record<string, unknown> | undefined);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = { type: "object", properties: {}, required: [] };
    for (const item of schema.allOf as Array<Record<string, unknown>>) {
      const resolved = resolveSchema(spec, item);
      if (!resolved) {
        continue;
      }
      Object.assign(merged.properties as Record<string, unknown>, (resolved.properties as Record<string, unknown>) ?? {});
      if (Array.isArray(resolved.required)) {
        (merged.required as unknown[]).push(...resolved.required);
      }
    }
    return merged;
  }
  return schema;
}

function schemaType(spec: OpenAPISpec, schema: Record<string, unknown> | undefined): string {
  const resolved = resolveSchema(spec, schema);
  if (!resolved) {
    return "unknown";
  }
  if (Array.isArray(resolved.oneOf)) {
    return (resolved.oneOf as Array<Record<string, unknown>>).map((item) => schemaType(spec, item)).join(" | ");
  }
  if (Array.isArray(resolved.anyOf)) {
    return (resolved.anyOf as Array<Record<string, unknown>>).map((item) => schemaType(spec, item)).join(" | ");
  }
  if (resolved.type === "array") {
    return `Array<${schemaType(spec, resolved.items as Record<string, unknown> | undefined)}>`;
  }
  if (Array.isArray(resolved.enum)) {
    return (resolved.enum as unknown[]).map(String).join(" | ");
  }
  if (resolved.type === "object" && resolved.additionalProperties) {
    return "object";
  }
  const type = typeof resolved.type === "string" ? resolved.type : "object";
  if (resolved.nullable) {
    return `${type} | null`;
  }
  return type;
}

function renderSchemaFields(spec: OpenAPISpec, schema: Record<string, unknown> | undefined, includeRequired = true): string[] {
  const resolved = resolveSchema(spec, schema);
  if (!resolved) {
    return [];
  }
  const properties = (resolved.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(resolved.required) ? (resolved.required as string[]) : []);
  return Object.entries(properties).map(([name, propertySchema]) => {
    const description = typeof propertySchema.description === "string" ? propertySchema.description : "";
    const suffix = description ? ` — ${description}` : "";
    const marker = includeRequired && required.has(name) ? "*" : "";
    return `  ${name}${marker}: ${schemaType(spec, propertySchema)}${suffix}`;
  });
}

function getOperation(spec: OpenAPISpec, method: string, path: string): OperationMatch | undefined {
  const normalizedMethod = method.toLowerCase();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const operation = (spec.paths?.[normalizedPath] as Record<string, Record<string, unknown>> | undefined)?.[normalizedMethod];
  if (!operation) {
    return undefined;
  }
  return { method: normalizedMethod, path: normalizedPath, operation };
}

function listOperations(spec: OpenAPISpec): OperationMatch[] {
  const results: OperationMatch[] = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
    const pathItem = rawPathItem as Record<string, Record<string, unknown>>;
    for (const method of METHOD_ORDER) {
      const operation = pathItem[method];
      if (operation) {
        results.push({ method, path, operation });
      }
    }
  }
  return results;
}

function findRelatedSummary(spec: OpenAPISpec, value: string): string | undefined {
  const [method, ...pathParts] = value.split(" ");
  const path = pathParts.join(" ");
  const match = getOperation(spec, method, path);
  return typeof match?.operation.summary === "string" ? match.operation.summary : undefined;
}

export function renderIndexFromSpec(spec: OpenAPISpec): string {
  const lines = [...FILTER_SYNTAX_BLOCK];
  const grouped = new Map<string, OperationMatch[]>();

  for (const match of listOperations(spec)) {
    const section = match.path.split("/")[1] ?? "other";
    const list = grouped.get(section) ?? [];
    list.push(match);
    grouped.set(section, list);
  }

  for (const [section, matches] of grouped) {
    lines.push(`## ${section}`);
    for (const match of matches) {
      const summary = typeof match.operation.summary === "string" ? match.operation.summary : "";
      const auth = String(match.operation["x-arke-auth"] ?? "optional");
      lines.push(
        `${match.method.toUpperCase().padEnd(6)} ${match.path.padEnd(40)} ${auth.padEnd(10)} ${summary}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderRouteHelpFromSpec(spec: OpenAPISpec, method: string, path: string): string | null {
  const match = getOperation(spec, method, path);
  if (!match) {
    return null;
  }

  const { operation } = match;
  const lines: string[] = [
    `${match.method.toUpperCase()} ${match.path}`,
    `Auth: ${String(operation["x-arke-auth"] ?? "optional")}`,
    `Summary: ${String(operation.summary ?? "")}`,
    "",
  ];

  const parameters = Array.isArray(operation.parameters)
    ? (operation.parameters as Array<Record<string, unknown>>)
    : [];

  const pathParams = parameters.filter((parameter) => parameter.in === "path");
  if (pathParams.length) {
    lines.push("Path params:");
    for (const parameter of pathParams) {
      const name = String(parameter.name ?? "");
      const required = parameter.required ? "*" : "";
      const description = String(parameter.description ?? "");
      lines.push(`  ${name}${required} — ${description}`);
    }
    lines.push("");
  }

  const queryParams = parameters.filter((parameter) => parameter.in === "query");
  if (queryParams.length) {
    lines.push("Query params:");
    for (const parameter of queryParams) {
      const name = String(parameter.name ?? "");
      const required = parameter.required ? "*" : "";
      const description = String(parameter.description ?? "");
      lines.push(`  ${name}${required} — ${description}`);
    }
    lines.push("");
  }

  const requestBody = operation.requestBody as Record<string, unknown> | undefined;
  const requestSchema = resolveSchema(
    spec,
    (((requestBody?.content as Record<string, Record<string, unknown>> | undefined)?.["application/json"] ??
      Object.values((requestBody?.content as Record<string, Record<string, unknown>> | undefined) ?? {})[0]) as
      | Record<string, unknown>
      | undefined)?.schema as Record<string, unknown> | undefined,
  );

  const bodyFields = renderSchemaFields(spec, requestSchema);
  if (bodyFields.length) {
    lines.push("Request body (JSON):");
    lines.push(...bodyFields);
    lines.push("");
  }

  const responses = (operation.responses ?? {}) as Record<string, Record<string, unknown>>;
  const primaryResponse =
    Object.entries(responses).find(([status]) => status.startsWith("2"))?.[1] ??
    Object.values(responses)[0];
  const responseSchema = resolveSchema(
    spec,
    (((primaryResponse?.content as Record<string, Record<string, unknown>> | undefined)?.["application/json"] ??
      Object.values((primaryResponse?.content as Record<string, Record<string, unknown>> | undefined) ?? {})[0]) as
      | Record<string, unknown>
      | undefined)?.schema as Record<string, unknown> | undefined,
  );
  const responseFields = renderSchemaFields(spec, responseSchema, false);
  if (responseFields.length) {
    lines.push("Response:");
    lines.push(...responseFields);
    lines.push("");
  }

  const related = Array.isArray(operation["x-arke-related"])
    ? (operation["x-arke-related"] as string[])
    : [];
  if (related.length) {
    lines.push("Related:");
    for (const value of related) {
      const summary = findRelatedSummary(spec, value);
      lines.push(summary ? `  ${value} — ${summary}` : `  ${value}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function renderRouteNotFoundFromSpec(spec: OpenAPISpec, method: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const suggestions = listOperations(spec)
    .filter(
      (match) =>
        match.path.includes(normalizedPath) ||
        normalizedPath.includes(match.path.split("/")[1] ?? "") ||
        match.method === method.toLowerCase(),
    )
    .slice(0, 5)
    .map((match) => `  ${match.method.toUpperCase()} ${match.path} — ${String(match.operation.summary ?? "")}`);

  let body = `Route not found: ${method.toUpperCase()} ${normalizedPath}\n`;
  if (suggestions.length) {
    body += `\nDid you mean:\n${suggestions.join("\n")}\n`;
  }
  body += "\nSee GET /help for the full route index.\n";
  return body;
}

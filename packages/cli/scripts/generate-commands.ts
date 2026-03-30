import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type OpenAPISpec = {
  openapi?: string;
  info?: {
    title?: string;
    version?: string;
  };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
  };
};

type PathItem = Record<string, OpenAPIOperation | unknown> & {
  parameters?: OpenAPIParameter[];
};

type OpenAPIOperation = {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<string, unknown>;
  "x-arke-auth"?: string;
};

type OpenAPIParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
};

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

type GeneratedField = {
  name: string;
  description: string;
  required: boolean;
  type: string;
  enumValues?: string[];
};

type GeneratedOperation = {
  operationId: string;
  group: string;
  action: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  auth: string;
  pathParams: GeneratedField[];
  queryParams: GeneratedField[];
  bodyFields: GeneratedField[];
};

type Override = {
  skip?: boolean;
  group?: string;
  action?: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = join(__dirname, "..", "spec", "openapi.snapshot.json");
const outputPath = join(__dirname, "..", "src", "generated", "index.ts");
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const OVERRIDES: Record<string, Override> = {
  // --- Skipped (handled by custom commands or not CLI-relevant) ---
  createAuthChallenge: { skip: true },
  registerAgent: { skip: true },
  recoverAgentAccess: { skip: true },
  uploadEntityContent: { skip: true },
  getEntityContent: { skip: true },
  createContentUploadUrl: { skip: true },
  completeContentUpload: { skip: true },
  deleteEntityContent: { skip: true },
  renameEntityContent: { skip: true },

  // --- Auth ---
  getAuthenticatedActor: { group: "auth", action: "me" },
  updateAuthenticatedActor: { group: "auth", action: "update-me" },
  createApiKey: { group: "auth", action: "create-key" },
  listApiKeys: { group: "auth", action: "list-keys" },
  revokeApiKey: { group: "auth", action: "revoke-key" },
  listInboxNotifications: { group: "auth", action: "inbox" },
  countInboxNotifications: { group: "auth", action: "inbox-count" },

  // --- Actors ---
  listActors: { group: "actors", action: "list" },
  createActor: { group: "actors", action: "create" },
  getActor: { group: "actors", action: "get" },
  updateActor: { group: "actors", action: "update" },
  deactivateActor: { group: "actors", action: "deactivate" },
  listActorActivity: { group: "actors", action: "activity" },

  // --- Arkes ---
  listArkes: { group: "arkes", action: "list" },
  createArke: { group: "arkes", action: "create" },
  getArke: { group: "arkes", action: "get" },
  updateArke: { group: "arkes", action: "update" },
  deleteArke: { group: "arkes", action: "delete" },

  // --- Entities ---
  createEntity: { group: "entities", action: "create" },
  getEntity: { group: "entities", action: "get" },
  updateEntity: { group: "entities", action: "update" },
  deleteEntity: { group: "entities", action: "delete" },
  changeEntityLevel: { group: "entities", action: "change-level" },
  transferEntityOwner: { group: "entities", action: "transfer-owner" },
  getEntityPermissions: { group: "entities", action: "permissions" },
  grantEntityPermission: { group: "entities", action: "grant" },
  revokeEntityPermission: { group: "entities", action: "revoke" },
  listEntityVersions: { group: "entities", action: "versions" },
  getEntityVersion: { group: "entities", action: "version" },
  listEntityActivity: { group: "entities", action: "activity" },

  // --- Relationships ---
  listRelationships: { group: "relationships", action: "list" },
  createRelationship: { group: "relationships", action: "create" },
  getRelationship: { group: "relationships", action: "get" },
  updateRelationship: { group: "relationships", action: "update" },
  deleteRelationship: { group: "relationships", action: "delete" },

  // --- Comments ---
  listComments: { group: "comments", action: "list" },
  createComment: { group: "comments", action: "create" },
  deleteComment: { group: "comments", action: "delete" },

  // --- Groups ---
  listGroups: { group: "groups", action: "list" },
  createGroup: { group: "groups", action: "create" },
  getGroup: { group: "groups", action: "get" },
  updateGroup: { group: "groups", action: "update" },
  deleteGroup: { group: "groups", action: "delete" },
  addGroupMember: { group: "groups", action: "add-member" },
  removeGroupMember: { group: "groups", action: "remove-member" },

  // --- Spaces ---
  listSpaces: { group: "spaces", action: "list" },
  createSpace: { group: "spaces", action: "create" },
  getSpace: { group: "spaces", action: "get" },
  updateSpace: { group: "spaces", action: "update" },
  deleteSpace: { group: "spaces", action: "delete" },
  listSpaceEntities: { group: "spaces", action: "list-entities" },
  addSpaceEntity: { group: "spaces", action: "add-entity" },
  removeSpaceEntity: { group: "spaces", action: "remove-entity" },
  listSpaceFeed: { group: "spaces", action: "feed" },
  listSpacePermissions: { group: "spaces", action: "permissions" },
  grantSpacePermission: { group: "spaces", action: "grant" },
  revokeSpacePermission: { group: "spaces", action: "revoke" },

  // --- Search ---
  searchEntities: { group: "search", action: "query" },

  // --- Activity ---
  listActivity: { group: "activity", action: "list" },
};

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function normalizeFieldDescription(name: string, description: string): string {
  if (name === "ver") {
    return "Expected current version (CAS token). Server increments ver on success.";
  }
  return description;
}

function schemaType(schema: JsonSchema | undefined): string {
  if (!schema) {
    return "string";
  }
  const raw = schema.type;
  if (Array.isArray(raw)) {
    const filtered = raw.filter((item) => item !== "null");
    return filtered[0] ?? "string";
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (schema.enum?.length) {
    return "string";
  }
  if (schema.items) {
    return "array";
  }
  if (schema.properties) {
    return "object";
  }
  return "string";
}

function resolveSchema(spec: OpenAPISpec, schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) {
    return undefined;
  }
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? "";
    return resolveSchema(spec, spec.components?.schemas?.[name]);
  }
  if (schema.allOf?.length) {
    const merged: JsonSchema = { type: "object", properties: {}, required: [] };
    for (const item of schema.allOf) {
      const resolved = resolveSchema(spec, item);
      if (!resolved) {
        continue;
      }
      Object.assign(merged.properties ?? {}, resolved.properties ?? {});
      merged.required = [...new Set([...(merged.required ?? []), ...(resolved.required ?? [])])];
    }
    return merged;
  }
  return schema;
}

function extractBodyFields(spec: OpenAPISpec, operation: OpenAPIOperation): GeneratedField[] {
  const jsonSchema = operation.requestBody?.content?.["application/json"]?.schema;
  const schema = resolveSchema(spec, jsonSchema);
  if (!schema?.properties) {
    return [];
  }
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, propertySchema]) => ({
    name,
    description: normalizeFieldDescription(name, propertySchema.description ?? ""),
    required: required.has(name),
    type: schemaType(resolveSchema(spec, propertySchema)),
    enumValues: propertySchema.enum?.map(String),
  }));
}

function deriveDefaultGroup(operation: OpenAPIOperation, path: string): string {
  const tag = operation.tags?.[0];
  if (tag) {
    return toKebabCase(tag);
  }
  return toKebabCase(path.split("/").filter(Boolean)[0] ?? "api");
}

function deriveDefaultAction(operationId: string, method: string, path: string): string {
  const baseSegment = path.split("/").filter(Boolean).at(-1) ?? "run";
  const verbMatch = operationId.match(/^(list|get|create|update|delete|count|transfer|rename|complete|search|revoke)(.+)$/);
  if (verbMatch) {
    const verb = toKebabCase(verbMatch[1]);
    const noun = toKebabCase(verbMatch[2]).replace(/^(entity|entities|commons|relationship|relationships|comment|comments|actor|activity|authenticated)-?/, "");
    if (!noun) {
      return verb;
    }
    if (verb === "get") {
      return noun;
    }
    return `${verb}-${noun}`;
  }
  if (method === "get") {
    return "get";
  }
  return `${method.toLowerCase()}-${toKebabCase(baseSegment.replace(/[{}]/g, ""))}`;
}

function buildParameters(spec: OpenAPISpec, pathItem: PathItem, operation: OpenAPIOperation) {
  const merged = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])] as OpenAPIParameter[];
  const seen = new Set<string>();
  const deduped = merged.filter((parameter) => {
    const key = `${parameter.in}:${parameter.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  const fields = deduped.map((parameter) => ({
    name: parameter.name,
    description: normalizeFieldDescription(parameter.name, parameter.description ?? ""),
    required: parameter.required ?? false,
    type: schemaType(resolveSchema(spec, parameter.schema)),
    enumValues: parameter.schema?.enum?.map(String),
  }));

  return {
    pathParams: fields.filter((field) => deduped.find((parameter) => parameter.name === field.name && parameter.in === "path")),
    queryParams: fields.filter((field) => deduped.find((parameter) => parameter.name === field.name && parameter.in === "query")),
  };
}

function parseOperations(spec: OpenAPISpec): GeneratedOperation[] {
  const operations: GeneratedOperation[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const typedOperation = operation as OpenAPIOperation;
      const operationId = typedOperation.operationId;
      if (!operationId) {
        continue;
      }

      const override = OVERRIDES[operationId];
      if (override?.skip) {
        continue;
      }

      const params = buildParameters(spec, pathItem, typedOperation);
      operations.push({
        operationId,
        group: override?.group ?? deriveDefaultGroup(typedOperation, path),
        action: override?.action ?? deriveDefaultAction(operationId, method, path),
        method: method.toUpperCase(),
        path,
        summary: typedOperation.summary ?? operationId,
        description: typedOperation.description ?? typedOperation.summary ?? operationId,
        auth: typedOperation["x-arke-auth"] ?? "optional",
        pathParams: params.pathParams,
        queryParams: params.queryParams,
        bodyFields: extractBodyFields(spec, typedOperation),
      });
    }
  }

  operations.sort((a, b) => `${a.group}:${a.action}`.localeCompare(`${b.group}:${b.action}`));
  return operations;
}

function renderField(field: GeneratedField): string {
  const enumPart = field.enumValues?.length ? `, enumValues: ${JSON.stringify(field.enumValues)}` : "";
  return `{ name: ${JSON.stringify(field.name)}, description: ${JSON.stringify(field.description)}, required: ${field.required}, type: ${JSON.stringify(field.type)}${enumPart} }`;
}

function generateIndex(spec: OpenAPISpec): string {
  const operations = parseOperations(spec);
  const groups = [...new Set(operations.map((operation) => operation.group))];

  return `// AUTO-GENERATED - DO NOT EDIT
// Generated from spec/openapi.snapshot.json

import { Command } from "commander";

import { registerGeneratedGroup, type GeneratedOperation } from "../lib/generated.js";

const OPERATIONS: GeneratedOperation[] = [
${operations
  .map(
    (operation) => `  {
    operationId: ${JSON.stringify(operation.operationId)},
    group: ${JSON.stringify(operation.group)},
    action: ${JSON.stringify(operation.action)},
    method: ${JSON.stringify(operation.method)},
    path: ${JSON.stringify(operation.path)},
    summary: ${JSON.stringify(operation.summary)},
    description: ${JSON.stringify(operation.description)},
    auth: ${JSON.stringify(operation.auth)},
    pathParams: [${operation.pathParams.map(renderField).join(", ")}],
    queryParams: [${operation.queryParams.map(renderField).join(", ")}],
    bodyFields: [${operation.bodyFields.map(renderField).join(", ")}],
  }`,
  )
  .join(",\n")}
];

export function registerApiCommands(program: Command, options: { skipExisting?: boolean } = {}): void {
  for (const group of ${JSON.stringify(groups)}) {
    const existing = program.commands.find((command) => command.name() === group);
    if (existing && options.skipExisting) {
      registerGeneratedGroup(existing, OPERATIONS.filter((operation) => operation.group === group));
      continue;
    }

    if (existing) {
      registerGeneratedGroup(existing, OPERATIONS.filter((operation) => operation.group === group));
      continue;
    }

    const groupCommand = program.command(group).description(\`\${group} operations\`);
    registerGeneratedGroup(groupCommand, OPERATIONS.filter((operation) => operation.group === group));
  }
}
`;
}

function main() {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as OpenAPISpec;
  const operations = parseOperations(spec);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generateIndex(spec));
  console.log(`Generated ${outputPath}`);
  console.log(`Generated operations: ${operations.length}`);
}

main();

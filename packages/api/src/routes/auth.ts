import { createRoute, z } from "@hono/zod-openapi";

import {
  createApiKey,
  randomHex,
  sha256Hex,
  verifyEd25519Signature,
  verifyPowSolution,
} from "../lib/auth";
import { createRouter } from "../lib/openapi";
import { assertBodyObject } from "../lib/entities";
import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { generateUlid } from "../lib/ids";
import {
  DateTimeSchema,
  EntityIdParam,
  EntitySchema,
  errorResponses,
  jsonContent,
  pathParam,
  queryParam,
} from "../lib/schemas";
import { createSql } from "../lib/sql";
import type { AppBindings } from "../types";

function parseTimestampWithinSkew(timestamp: unknown, skewMs = 5 * 60 * 1000) {
  if (typeof timestamp !== "string") {
    throw new ApiError(400, "invalid_body", "Invalid timestamp");
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "invalid_body", "Invalid timestamp");
  }

  if (Math.abs(Date.now() - date.getTime()) > skewMs) {
    throw new ApiError(400, "invalid_body", "Timestamp out of range");
  }

  return date.toISOString();
}

const challengeRoute = createRoute({
  method: "post",
  path: "/challenge",
  operationId: "createAuthChallenge",
  tags: ["Auth"],
  summary: "Request a proof-of-work challenge for registration",
  "x-arke-auth": "none",
  "x-arke-related": ["POST /auth/register"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          public_key: z.string().describe("Ed25519 public key (hex)"),
        }),
      ),
    },
  },
  responses: {
    200: {
      description: "Proof-of-work challenge",
      content: jsonContent(
        z.object({
          nonce: z.string(),
          difficulty: z.number().int(),
          expires_at: DateTimeSchema,
        }),
      ),
    },
    ...errorResponses([400]),
  },
});

const registerRoute = createRoute({
  method: "post",
  path: "/register",
  operationId: "registerAgent",
  tags: ["Auth"],
  summary: "Register a new agent with Ed25519 key + PoW",
  "x-arke-auth": "none",
  "x-arke-related": ["POST /auth/challenge", "POST /auth/recover"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          public_key: z.string().describe("Ed25519 public key (hex)"),
          nonce: z.string().describe("From /auth/challenge"),
          signature: z.string().describe("Ed25519 signature of nonce"),
          solution: z.number().int().describe("PoW solution"),
          name: z.string().optional().describe("Agent display name"),
          metadata: z.record(z.string(), z.any()).optional().describe("Additional properties"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Agent registered",
      content: jsonContent(
        z.object({
          entity: EntitySchema,
          api_key: z.string(),
          key_prefix: z.string(),
        }),
      ),
    },
    ...errorResponses([400, 409, 410]),
  },
});

const recoverRoute = createRoute({
  method: "post",
  path: "/recover",
  operationId: "recoverAgentAccess",
  tags: ["Auth"],
  summary: "Recover agent access by signing with Ed25519 key",
  "x-arke-auth": "none",
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          public_key: z.string().describe("Ed25519 public key (hex)"),
          signature: z.string().describe(
            "Signature of JSON { action: 'recover', timestamp }",
          ),
          timestamp: DateTimeSchema.describe("ISO 8601 (within 5 min skew)"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Fresh API key issued",
      content: jsonContent(
        z.object({
          entity_id: EntityIdParam,
          api_key: z.string(),
          key_prefix: z.string(),
        }),
      ),
    },
    ...errorResponses([400, 401, 404]),
  },
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  operationId: "getAuthenticatedActor",
  tags: ["Auth"],
  summary: "Get the authenticated actor's entity",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/me/inbox"],
  responses: {
    200: {
      description: "Authenticated actor",
      content: jsonContent(z.object({ entity: EntitySchema })),
    },
    ...errorResponses([401, 404]),
  },
});

const createKeyRoute = createRoute({
  method: "post",
  path: "/keys",
  operationId: "createApiKey",
  tags: ["Auth"],
  summary: "Create a new API key for the authenticated actor",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/keys", "DELETE /auth/keys/{id}"],
  request: {
    body: {
      content: jsonContent(
        z.object({
          label: z.string().optional().describe("Optional key label"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "API key created",
      content: jsonContent(
        z.object({
          id: EntityIdParam,
          key_prefix: z.string(),
          api_key: z.string(),
          label: z.string().nullable(),
        }),
      ),
    },
    ...errorResponses([400, 401]),
  },
});

const listKeysRoute = createRoute({
  method: "get",
  path: "/keys",
  operationId: "listApiKeys",
  tags: ["Auth"],
  summary: "List API keys for the authenticated actor",
  "x-arke-auth": "required",
  "x-arke-related": ["POST /auth/keys", "DELETE /auth/keys/{id}"],
  request: {
    query: z.object({
      include_revoked: queryParam(
        "include_revoked",
        z.enum(["true", "false"]).optional(),
        "boolean — Include revoked keys (default: false)",
      ),
    }),
  },
  responses: {
    200: {
      description: "API keys",
      content: jsonContent(
        z.object({
          keys: z.array(
            z.object({
              id: EntityIdParam,
              key_prefix: z.string(),
              label: z.string().nullable(),
              created_at: DateTimeSchema,
              last_used_at: DateTimeSchema.nullable(),
              revoked_at: DateTimeSchema.nullable(),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([401]),
  },
});

const revokeKeyRoute = createRoute({
  method: "delete",
  path: "/keys/{id}",
  operationId: "revokeApiKey",
  tags: ["Auth"],
  summary: "Revoke an API key",
  "x-arke-auth": "required",
  "x-arke-related": ["GET /auth/keys"],
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "API key ULID"),
    }),
  },
  responses: {
    204: {
      description: "API key revoked",
    },
    ...errorResponses([401, 403, 404]),
  },
});

export const authRouter = createRouter();

authRouter.openapi(challengeRoute, async (c) => {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.public_key !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing public_key");
  }

  const nonce = randomHex(32);
  const difficulty = 22;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const sql = createSql(c.env);

  await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`
      INSERT INTO pow_challenges (nonce, public_key, difficulty, expires_at)
      VALUES (${nonce}, ${body.public_key}, ${difficulty}, ${expiresAt}::timestamptz)
    `,
  ]);

  return c.json({
    nonce,
    difficulty,
    expires_at: expiresAt,
  }, 200);
});

authRouter.openapi(registerRoute, async (c) => {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (
    typeof body.public_key !== "string" ||
    typeof body.nonce !== "string" ||
    typeof body.signature !== "string" ||
    typeof body.solution !== "number"
  ) {
    throw new ApiError(400, "invalid_body", "Invalid registration payload");
  }

  const sql = createSql(c.env);
  const [, challengeRows, existingRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`
      SELECT nonce, public_key, difficulty, expires_at
      FROM pow_challenges
      WHERE nonce = ${body.nonce}
      LIMIT 1
    `,
    sql`
      SELECT entity_id
      FROM agent_keys
      WHERE public_key = ${body.public_key}
      LIMIT 1
    `,
  ]);

  if ((existingRows as Array<{ entity_id: string }>).length > 0) {
    throw new ApiError(409, "already_exists", "Public key already registered");
  }

  const challenge = (challengeRows as Array<{
    nonce: string;
    public_key: string;
    difficulty: number;
    expires_at: string;
  }>)[0];
  if (!challenge) {
    throw new ApiError(410, "pow_expired", "Challenge expired or already used");
  }
  if (challenge.public_key !== body.public_key) {
    throw new ApiError(400, "pow_invalid", "Public key does not match challenge");
  }
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    throw new ApiError(410, "pow_expired", "Challenge expired or already used");
  }

  const powValid = await verifyPowSolution(
    challenge.nonce,
    challenge.public_key,
    body.solution,
    challenge.difficulty,
  );
  if (!powValid) {
    throw new ApiError(400, "pow_invalid", "Invalid proof-of-work solution");
  }

  const signatureValid = await verifyEd25519Signature(
    body.public_key,
    body.signature,
    challenge.nonce,
  );
  if (!signatureValid) {
    throw new ApiError(400, "signature_invalid", "Invalid signature");
  }

  const entityId = generateUlid();
  const apiKey = createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.value);
  const keyId = generateUlid();
  const now = new Date().toISOString();
  const metadata =
    body.metadata === undefined ? {} : assertBodyObject(body.metadata, "metadata");
  const properties = {
    ...(metadata ?? {}),
    ...(typeof body.name === "string" ? { label: body.name } : {}),
    public_key: body.public_key,
  };

  const [, , entityRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`DELETE FROM pow_challenges WHERE nonce = ${body.nonce}`,
    sql`
      INSERT INTO entities (
        id, kind, type, ver, properties, owner_id, commons_id,
        edited_by, note, created_at, updated_at
      )
      VALUES (
        ${entityId}, 'agent', 'agent', 1, ${JSON.stringify(properties)}::jsonb,
        ${entityId}, NULL, ${entityId}, NULL, ${now}::timestamptz, ${now}::timestamptz
      )
      RETURNING *
    `,
    sql`
      INSERT INTO agent_keys (entity_id, public_key)
      VALUES (${entityId}, ${body.public_key})
    `,
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id)
      VALUES (${keyId}, ${apiKey.keyPrefix}, ${apiKeyHash}, ${entityId})
    `,
  ]);

  return c.json(
    {
      entity: (entityRows as Array<Record<string, unknown>>)[0],
      api_key: apiKey.value,
      key_prefix: apiKey.keyPrefix,
    },
    201,
  );
});

authRouter.openapi(recoverRoute, async (c) => {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.public_key !== "string" || typeof body.signature !== "string") {
    throw new ApiError(400, "invalid_body", "Invalid recovery payload");
  }

  const timestamp = parseTimestampWithinSkew(body.timestamp);
  const payload = JSON.stringify({ action: "recover", timestamp });
  const signatureValid = await verifyEd25519Signature(
    body.public_key,
    body.signature,
    payload,
  );
  if (!signatureValid) {
    throw new ApiError(401, "signature_invalid", "Invalid signature");
  }

  const sql = createSql(c.env);
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`
      SELECT entity_id
      FROM agent_keys
      WHERE public_key = ${body.public_key}
      LIMIT 1
    `,
  ]);

  const agent = (rows as Array<{ entity_id: string }>)[0];
  if (!agent) {
    throw new ApiError(404, "not_found", "Agent not found");
  }

  const apiKey = createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.value);
  const keyId = generateUlid();
  await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`UPDATE api_keys SET revoked_at = NOW() WHERE actor_id = ${agent.entity_id} AND revoked_at IS NULL`,
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id)
      VALUES (${keyId}, ${apiKey.keyPrefix}, ${apiKeyHash}, ${agent.entity_id})
    `,
  ]);

  return c.json(
    {
      entity_id: agent.entity_id,
      api_key: apiKey.value,
      key_prefix: apiKey.keyPrefix,
    },
    201,
  );
});

authRouter.openapi(meRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql(c.env);

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`SELECT * FROM entities WHERE id = ${actor.id} LIMIT 1`,
  ]);

  const entity = (rows as Array<Record<string, unknown>>)[0];
  if (!entity) {
    throw new ApiError(404, "not_found", "Authenticated actor not found");
  }

  return c.json({ entity }, 200);
});

authRouter.openapi(createKeyRoute, async (c) => {
  const actor = requireActor(c);
  let body: Record<string, unknown> = {};
  if (c.req.header("content-length") !== "0") {
    body = await parseJsonBody<Record<string, unknown>>(c).catch(() => ({}));
  }
  const label =
    body.label === undefined ? null : typeof body.label === "string" ? body.label : null;
  if (body.label !== undefined && label === null) {
    throw new ApiError(400, "invalid_body", "Invalid label");
  }

  const apiKey = createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.value);
  const keyId = generateUlid();
  const sql = createSql(c.env);

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`
      INSERT INTO api_keys (id, key_prefix, key_hash, actor_id, label)
      VALUES (${keyId}, ${apiKey.keyPrefix}, ${apiKeyHash}, ${actor.id}, ${label})
      RETURNING id, key_prefix, label
    `,
  ]);

  return c.json(
    {
      ...(rows as Array<Record<string, unknown>>)[0],
      api_key: apiKey.value,
    },
    201,
  );
});

authRouter.openapi(listKeysRoute, async (c) => {
  const actor = requireActor(c);
  const includeRevoked = c.req.query("include_revoked") === "true";
  const sql = createSql(c.env);

  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql.query(
      `
        SELECT id, key_prefix, label, created_at, last_used_at, revoked_at
        FROM api_keys
        WHERE actor_id = $1
          AND ($2::boolean OR revoked_at IS NULL)
        ORDER BY created_at DESC
      `,
      [actor.id, includeRevoked],
    ),
  ]);

  return c.json({ keys: rows }, 200);
});

authRouter.openapi(revokeKeyRoute, async (c) => {
  const actor = requireActor(c);
  const keyId = c.req.param("id");
  if (keyId === actor.apiKeyId) {
    throw new ApiError(403, "forbidden", "Cannot revoke the key currently in use");
  }

  const sql = createSql(c.env);
  const [, rows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', ${actor.id}, true)`,
    sql`
      UPDATE api_keys
      SET revoked_at = NOW()
      WHERE id = ${keyId}
        AND actor_id = ${actor.id}
        AND revoked_at IS NULL
      RETURNING id
    `,
  ]);

  if ((rows as Array<{ id: string }>).length === 0) {
    throw new ApiError(404, "not_found", "API key not found");
  }

  return new Response(null, { status: 204 });
});

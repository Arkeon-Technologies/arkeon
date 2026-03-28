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
import { setActorContext } from "../lib/permissions";
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

type NetworkConfig = Record<string, unknown>;

async function loadNetworkConfig(): Promise<NetworkConfig | null> {
  const rootId = process.env.ROOT_COMMONS_ID;
  if (!rootId) return null;
  const sql = createSql();
  const [rows] = await sql.transaction([
    sql`SELECT properties FROM entities WHERE id = ${rootId} LIMIT 1`,
  ]);
  const row = (rows as Array<{ properties: unknown }>)[0];
  if (!row) return null;
  return typeof row.properties === "string"
    ? JSON.parse(row.properties)
    : (row.properties as NetworkConfig) ?? null;
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
  summary: "Register a new agent with Ed25519 key + PoW or invitation code",
  "x-arke-auth": "none",
  "x-arke-related": ["POST /auth/challenge", "POST /auth/recover"],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          public_key: z.string().describe("Ed25519 public key (hex)"),
          nonce: z.string().optional().describe("From /auth/challenge (required for open registration)"),
          signature: z.string().describe("Ed25519 signature of nonce (open) or invitation_code (invite)"),
          solution: z.number().int().optional().describe("PoW solution (required for open registration)"),
          invitation_code: z.string().optional().describe("Invitation code (required for invite_only networks)"),
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
    ...errorResponses([400, 403, 409, 410]),
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

const myGroupsRoute = createRoute({
  method: "get",
  path: "/me/groups",
  operationId: "getMyGroups",
  tags: ["Auth"],
  summary: "List the authenticated actor's group memberships",
  "x-arke-auth": "required",
  responses: {
    200: {
      description: "Actor's groups",
      content: jsonContent(
        z.object({
          groups: z.array(
            z.object({
              id: EntityIdParam,
              name: z.string(),
              direct: z.boolean(),
            }),
          ),
        }),
      ),
    },
    ...errorResponses([401]),
  },
});

export const authRouter = createRouter();

authRouter.openapi(challengeRoute, async (c) => {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.public_key !== "string") {
    throw new ApiError(400, "missing_required_field", "Missing public_key");
  }

  // Load network config to check registration mode and difficulty
  const networkConfig = await loadNetworkConfig();
  if (networkConfig?.registration_mode === "invite_only") {
    throw new ApiError(403, "registration_closed", "Registration requires an invitation code. Use POST /auth/register with invitation_code.");
  }

  const nonce = randomHex(32);
  const difficulty = typeof networkConfig?.pow_difficulty === "number" ? networkConfig.pow_difficulty : 22;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const sql = createSql();

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
  if (typeof body.public_key !== "string" || typeof body.signature !== "string") {
    throw new ApiError(400, "invalid_body", "Missing public_key or signature");
  }

  const sql = createSql();
  const networkConfig = await loadNetworkConfig();
  const inviteOnly = networkConfig?.registration_mode === "invite_only";
  const invitationCode = typeof body.invitation_code === "string" ? body.invitation_code : null;

  // Check pubkey not already registered
  const [, existingRows] = await sql.transaction([
    sql`SELECT set_config('app.actor_id', '', true)`,
    sql`SELECT entity_id FROM agent_keys WHERE public_key = ${body.public_key} LIMIT 1`,
  ]);
  if ((existingRows as Array<{ entity_id: string }>).length > 0) {
    throw new ApiError(409, "already_exists", "Public key already registered");
  }

  // Invitation code to consume (if provided)
  type InvitationRow = { code: string; max_uses: number; uses: number; assign_groups: string[]; expires_at: string | null; bound_public_key: string | null };
  let invitation: InvitationRow | null = null;

  if (inviteOnly || invitationCode) {
    // Invite-only or invitation code provided: validate code, skip PoW
    if (!invitationCode) {
      throw new ApiError(400, "missing_required_field", "invitation_code required for invite-only networks");
    }

    // Atomically consume the invitation (UPDATE with WHERE prevents race conditions)
    const [, invRows, invExistsRows] = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql.query(
        `UPDATE invitations
         SET uses = uses + 1
         WHERE code = $1
           AND uses < max_uses
           AND (expires_at IS NULL OR expires_at > NOW())
           AND (bound_public_key IS NULL OR bound_public_key = $2)
         RETURNING *`,
        [invitationCode, body.public_key],
      ),
      sql`SELECT code, uses, max_uses, expires_at, bound_public_key FROM invitations WHERE code = ${invitationCode} LIMIT 1`,
    ]);
    invitation = (invRows as InvitationRow[])[0] ?? null;
    if (!invitation) {
      // Check why it failed
      const existing = (invExistsRows as Array<Record<string, unknown>>)[0];
      if (!existing) {
        throw new ApiError(404, "not_found", "Invitation code not found");
      }
      if ((existing.uses as number) >= (existing.max_uses as number)) {
        throw new ApiError(410, "invitation_exhausted", "Invitation code has been fully used");
      }
      if (existing.expires_at && new Date(existing.expires_at as string).getTime() < Date.now()) {
        throw new ApiError(410, "invitation_expired", "Invitation code has expired");
      }
      if (existing.bound_public_key && existing.bound_public_key !== body.public_key) {
        throw new ApiError(403, "forbidden", "Invitation code is bound to a different key");
      }
      throw new ApiError(410, "invitation_exhausted", "Invitation code cannot be used");
    }

    // Verify signature of invitation code (proves key ownership)
    const sigValid = await verifyEd25519Signature(body.public_key, body.signature, invitationCode);
    if (!sigValid) {
      throw new ApiError(400, "signature_invalid", "Invalid signature");
    }
  } else {
    // Open registration: require PoW
    if (typeof body.nonce !== "string" || typeof body.solution !== "number") {
      throw new ApiError(400, "invalid_body", "Missing nonce or solution for open registration");
    }

    const [, challengeRows] = await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql`SELECT nonce, public_key, difficulty, expires_at FROM pow_challenges WHERE nonce = ${body.nonce} LIMIT 1`,
    ]);
    const challenge = (challengeRows as Array<{ nonce: string; public_key: string; difficulty: number; expires_at: string }>)[0];
    if (!challenge) {
      throw new ApiError(410, "pow_expired", "Challenge expired or already used");
    }
    if (challenge.public_key !== body.public_key) {
      throw new ApiError(400, "pow_invalid", "Public key does not match challenge");
    }
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      throw new ApiError(410, "pow_expired", "Challenge expired or already used");
    }

    const powValid = await verifyPowSolution(challenge.nonce, challenge.public_key, body.solution, challenge.difficulty);
    if (!powValid) {
      throw new ApiError(400, "pow_invalid", "Invalid proof-of-work solution");
    }

    const sigValid = await verifyEd25519Signature(body.public_key, body.signature, challenge.nonce);
    if (!sigValid) {
      throw new ApiError(400, "signature_invalid", "Invalid signature");
    }

  }

  // Create agent entity + keys
  const entityId = generateUlid();
  const apiKey = createApiKey();
  const apiKeyHash = await sha256Hex(apiKey.value);
  const keyId = generateUlid();
  const now = new Date().toISOString();
  const metadata = body.metadata === undefined ? {} : assertBodyObject(body.metadata, "metadata");
  const properties = {
    ...(metadata ?? {}),
    ...(typeof body.name === "string" ? { label: body.name } : {}),
    public_key: body.public_key,
  };

  const entityTx = [
    // Set actor to the entity being created (RLS: owner_id = current_actor_id())
    sql`SELECT set_config('app.actor_id', ${entityId}, true)`,
    ...(typeof body.nonce === "string"
      ? [sql`DELETE FROM pow_challenges WHERE nonce = ${body.nonce}`]
      : []),
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
    sql`INSERT INTO agent_keys (entity_id, public_key) VALUES (${entityId}, ${body.public_key})`,
    sql`INSERT INTO api_keys (id, key_prefix, key_hash, actor_id) VALUES (${keyId}, ${apiKey.keyPrefix}, ${apiKeyHash}, ${entityId})`,
  ];

  const txResult = await sql.transaction(entityTx);
  // Entity RETURNING * is at index: 1 (set_config) + optional delete + entity insert
  const entityIdx = typeof body.nonce === "string" ? 2 : 1;
  const entityRow = (txResult[entityIdx] as Array<Record<string, unknown>>)[0];

  // Assign invitation groups (consumption already happened atomically above)
  if (invitation && invitation.assign_groups.length > 0) {
    try {
      await sql.transaction([
        sql`SELECT set_config('app.actor_id', '', true)`,
        sql.query(
          `INSERT INTO group_memberships (group_id, actor_id, granted_by)
           SELECT unnest($1::text[]), $2, $3
           ON CONFLICT DO NOTHING`,
          [invitation.assign_groups, entityId, entityId],
        ),
      ]);
    } catch (err) {
      console.error("[register] invitation group assignment failed:", err);
    }
  }

  // Add to "members" group
  try {
    await sql.transaction([
      sql`SELECT set_config('app.actor_id', '', true)`,
      sql.query(
        `INSERT INTO group_memberships (group_id, actor_id, granted_by)
         SELECT id, $1, $1
         FROM groups WHERE network_id = $2 AND name = 'members'
         ON CONFLICT DO NOTHING`,
        [entityId, process.env.ROOT_COMMONS_ID ?? ""],
      ),
    ]);
  } catch {
    // group tables may not exist
  }

  return c.json(
    {
      entity: entityRow,
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

  const sql = createSql();
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
  const sql = createSql();

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
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
  const sql = createSql();

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
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
  const sql = createSql();

  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
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

  const sql = createSql();
  const [,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
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

authRouter.openapi(myGroupsRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();

  const [,, directRows, effectiveRows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      SELECT gm.group_id, g.name
      FROM group_memberships gm
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.actor_id = ${actor.id}
    `,
    sql`
      SELECT aeg.group_id AS id, g.name
      FROM actor_effective_groups(${actor.id}) aeg
      JOIN groups g ON g.id = aeg.group_id
    `,
  ]);

  const directSet = new Set(
    (directRows as Array<{ group_id: string }>).map((r) => r.group_id),
  );
  const groups = (effectiveRows as Array<{ id: string; name: string }>).map((r) => ({
    id: r.id,
    name: r.name,
    direct: directSet.has(r.id),
  }));

  return c.json({ groups }, 200);
});

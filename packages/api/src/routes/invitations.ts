import { createRoute, z } from "@hono/zod-openapi";

import { ApiError } from "../lib/errors";
import { requireActor, parseJsonBody } from "../lib/http";
import { setActorContext, canInvite, isNetworkAdmin } from "../lib/permissions";
import { randomHex } from "../lib/auth";
import { createRouter } from "../lib/openapi";
import { createSql } from "../lib/sql";
import {
  DateTimeSchema,
  EntityIdParam,
  errorResponses,
  jsonContent,
  pathParam,
} from "../lib/schemas";

const InvitationSchema = z.object({
  code: z.string(),
  max_uses: z.number().int(),
  assign_groups: z.array(z.string()),
  expires_at: DateTimeSchema.nullable(),
  created_at: DateTimeSchema,
});

const createInvitationRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createInvitation",
  tags: ["Invitations"],
  summary: "Create an invitation code",
  "x-arke-auth": "required",
  "x-arke-related": [
    "GET /invitations",
    "DELETE /invitations/{code}",
  ],
  request: {
    body: {
      required: true,
      content: jsonContent(
        z.object({
          max_uses: z.number().int().min(1).optional().describe("Maximum number of uses (default 1)"),
          assign_groups: z.array(z.string()).optional().describe("Group IDs to assign on redemption"),
          expires_in: z.number().int().min(1).optional().describe("Seconds until expiration (mutually exclusive with expires_at)"),
          expires_at: z.string().datetime({ offset: true }).optional().describe("ISO 8601 expiration timestamp (mutually exclusive with expires_in)"),
          bound_public_key: z.string().optional().describe("Ed25519 public key to bind the invitation to"),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Invitation created",
      content: jsonContent(InvitationSchema),
    },
    ...errorResponses([400, 401, 403]),
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listInvitations",
  tags: ["Invitations"],
  summary: "List invitations (admins see all, others see own)",
  "x-arke-auth": "required",
  "x-arke-related": [
    "POST /invitations",
    "DELETE /invitations/{code}",
  ],
  request: {},
  responses: {
    200: {
      description: "List of invitations",
      content: jsonContent(
        z.object({
          invitations: z.array(InvitationSchema.extend({
            id: EntityIdParam,
            created_by: EntityIdParam,
            uses: z.number().int(),
          })),
        }),
      ),
    },
    ...errorResponses([401]),
  },
});

const revokeInvitationRoute = createRoute({
  method: "delete",
  path: "/{code}",
  operationId: "revokeInvitation",
  tags: ["Invitations"],
  summary: "Revoke an invitation code",
  "x-arke-auth": "required",
  "x-arke-related": [
    "POST /invitations",
    "GET /invitations",
  ],
  request: {
    params: z.object({
      code: pathParam("code", z.string(), "Invitation code"),
    }),
  },
  responses: {
    204: {
      description: "Invitation revoked",
    },
    ...errorResponses([401, 403, 404]),
  },
});

export const invitationsRouter = createRouter();

invitationsRouter.openapi(createInvitationRoute, async (c) => {
  const actor = requireActor(c);

  const allowed = await canInvite(actor.id);
  if (!allowed) {
    throw new ApiError(403, "forbidden", "You do not have permission to create invitations");
  }

  const body = await parseJsonBody<Record<string, unknown>>(c);
  const maxUses = body.max_uses !== undefined ? Number(body.max_uses) : 1;
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    throw new ApiError(400, "invalid_body", "max_uses must be an integer >= 1");
  }

  const assignGroups = Array.isArray(body.assign_groups) ? body.assign_groups as string[] : [];
  const expiresIn = body.expires_in !== undefined ? Number(body.expires_in) : undefined;
  const expiresAtRaw = typeof body.expires_at === "string" ? body.expires_at : undefined;
  const boundPublicKey = typeof body.bound_public_key === "string" ? body.bound_public_key : undefined;

  if (expiresIn !== undefined && expiresAtRaw !== undefined) {
    throw new ApiError(400, "invalid_body", "expires_in and expires_at are mutually exclusive");
  }

  let expiresAt: string | null = null;
  if (expiresIn !== undefined) {
    if (!Number.isInteger(expiresIn) || expiresIn < 1) {
      throw new ApiError(400, "invalid_body", "expires_in must be a positive integer (seconds)");
    }
    expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  } else if (expiresAtRaw !== undefined) {
    expiresAt = expiresAtRaw;
  }

  const sql = createSql();

  // Validate assign_groups exist in the network
  if (assignGroups.length > 0) {
    const [, , groupRows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT id FROM groups WHERE id = ANY(${assignGroups})`,
    ]);
    const foundIds = new Set((groupRows as Array<{ id: string }>).map((r) => r.id));
    const missing = assignGroups.filter((g) => !foundIds.has(g));
    if (missing.length > 0) {
      throw new ApiError(400, "invalid_body", `Groups not found: ${missing.join(", ")}`);
    }

    // Non-admin: can only assign groups they belong to
    const admin = await isNetworkAdmin(actor.id);
    if (!admin) {
      const actorGroupSet = new Set(actor.groups);
      const unauthorized = assignGroups.filter((g) => !actorGroupSet.has(g));
      if (unauthorized.length > 0) {
        throw new ApiError(403, "forbidden", `You are not a member of groups: ${unauthorized.join(", ")}`);
      }
    }
  }

  const code = randomHex(32);
  const now = new Date().toISOString();

  const [, , rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO invitations (code, network_id, created_by, max_uses, assign_groups, expires_at, bound_public_key, created_at)
      VALUES (${code}, ${process.env.ROOT_COMMONS_ID!}, ${actor.id}, ${maxUses}, ${`{${assignGroups.join(",")}}`}, ${expiresAt}::timestamptz, ${boundPublicKey ?? null}, ${now}::timestamptz)
      RETURNING code, max_uses, assign_groups, expires_at, created_at
    `,
  ]);

  const row = (rows as Array<Record<string, unknown>>)[0];
  return c.json(row, 201);
});

invitationsRouter.openapi(listInvitationsRoute, async (c) => {
  const actor = requireActor(c);
  const sql = createSql();
  const admin = await isNetworkAdmin(actor.id);

  const [, , rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    admin
      ? sql`SELECT code, created_by, max_uses, uses, assign_groups, expires_at, bound_public_key, created_at FROM invitations ORDER BY created_at DESC`
      : sql`SELECT code, created_by, max_uses, uses, assign_groups, expires_at, bound_public_key, created_at FROM invitations WHERE created_by = ${actor.id} ORDER BY created_at DESC`,
  ]);

  return c.json({ invitations: rows as Array<Record<string, unknown>> }, 200);
});

invitationsRouter.openapi(revokeInvitationRoute, async (c) => {
  const actor = requireActor(c);
  const code = c.req.param("code");
  const sql = createSql();

  const [, , rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`SELECT code, created_by FROM invitations WHERE code = ${code} LIMIT 1`,
  ]);

  const invitation = (rows as Array<{ code: string; created_by: string }>)[0];
  if (!invitation) {
    throw new ApiError(404, "not_found", "Invitation not found");
  }

  const admin = await isNetworkAdmin(actor.id);
  if (invitation.created_by !== actor.id && !admin) {
    throw new ApiError(403, "forbidden", "Only the creator or an admin can revoke this invitation");
  }

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM invitations WHERE code = ${code}`,
  ]);

  return new Response(null, { status: 204 });
});

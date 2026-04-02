import { createRoute, z } from "@hono/zod-openapi";

import { encodeCursor } from "../lib/cursor";
import { ApiError } from "../lib/errors";
import { requireActor, parseCursorParam, parseJsonBody, parseLimit } from "../lib/http";
import { setActorContext } from "../lib/actor-context";
import { generateUlid } from "../lib/ids";
import { fanOutNotifications } from "../lib/notifications";
import { createRouter } from "../lib/openapi";
import {
  DateTimeSchema,
  EntityIdParam,
  cursorResponseSchema,
  entityIdParams,
  errorResponses,
  jsonContent,
  paginationQuerySchema,
  pathParam,
} from "../lib/schemas";
import { backgroundTask } from "../lib/background";
import { createSql } from "../lib/sql";

const CommentReplySchema = z.object({
  id: EntityIdParam,
  entity_id: EntityIdParam,
  author_id: EntityIdParam,
  body: z.string(),
  parent_id: EntityIdParam.nullable(),
  created_at: DateTimeSchema,
});

const CommentSchema = CommentReplySchema.extend({
  replies: z.array(CommentReplySchema).optional(),
});

const createCommentRoute = createRoute({
  method: "post",
  path: "/{id}/comments",
  operationId: "createComment",
  tags: ["Comments"],
  summary: "Post a comment on an entity",
  "x-arke-auth": "required",
  "x-arke-related": [
    "GET /entities/{id}/comments",
    "DELETE /entities/{id}/comments/{commentId}",
  ],
  request: {
    params: entityIdParams(),
    body: {
      required: true,
      content: jsonContent(
        z.object({
          body: z.string().min(1).max(4096).describe("Comment text (1-4096 chars)"),
          parent_id: EntityIdParam.optional().describe(
            "Reply to a top-level comment ULID",
          ),
        }),
      ),
    },
  },
  responses: {
    201: {
      description: "Comment created",
      content: jsonContent(
        z.object({
          id: EntityIdParam,
          entity_id: EntityIdParam,
          author_id: EntityIdParam,
          body: z.string(),
          parent_id: EntityIdParam.nullable(),
          created_at: DateTimeSchema,
        }),
      ),
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

const listCommentsRoute = createRoute({
  method: "get",
  path: "/{id}/comments",
  operationId: "listComments",
  tags: ["Comments"],
  summary: "List comments on an entity with nested replies",
  "x-arke-auth": "optional",
  request: {
    params: entityIdParams(),
    query: paginationQuerySchema(50, 200),
  },
  responses: {
    200: {
      description: "Comments with nested replies",
      content: jsonContent(cursorResponseSchema("comments", CommentSchema)),
    },
    ...errorResponses([400, 403, 404]),
  },
});

const deleteCommentRoute = createRoute({
  method: "delete",
  path: "/{id}/comments/{commentId}",
  operationId: "deleteComment",
  tags: ["Comments"],
  summary: "Delete a comment (author, entity owner, or admin)",
  "x-arke-auth": "required",
  request: {
    params: z.object({
      id: pathParam("id", EntityIdParam, "Entity ULID"),
      commentId: pathParam("commentId", EntityIdParam, "Comment ULID"),
    }),
  },
  responses: {
    204: {
      description: "Comment deleted",
    },
    ...errorResponses([400, 401, 403, 404]),
  },
});

export const commentsRouter = createRouter();

commentsRouter.openapi(createCommentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (typeof body.body !== "string" || body.body.length < 1 || body.body.length > 4096) {
    throw new ApiError(400, "invalid_body", "Invalid comment body");
  }
  const parentId = body.parent_id === undefined ? null : typeof body.parent_id === "string" ? body.parent_id : null;
  if (body.parent_id !== undefined && parentId === null) {
    throw new ApiError(400, "invalid_body", "Invalid parent_id");
  }

  const id = generateUlid();
  const now = new Date().toISOString();
  const sql = createSql();

  if (parentId) {
    const [,,,,, parentRows] = await sql.transaction([
      ...setActorContext(sql, actor),
      sql`SELECT id, parent_id FROM comments WHERE id = ${parentId} AND entity_id = ${entityId} LIMIT 1`,
    ]);
    const parent = (parentRows as Array<{ id: string; parent_id: string | null }>)[0];
    if (!parent) {
      throw new ApiError(404, "not_found", "Parent comment not found");
    }
    if (parent.parent_id) {
      throw new ApiError(400, "invalid_body", "Replies may only target top-level comments");
    }
  }

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql`
      INSERT INTO comments (id, entity_id, author_id, body, parent_id, created_at)
      VALUES (${id}, ${entityId}, ${actor.id}, ${body.body}, ${parentId}, ${now}::timestamptz)
      RETURNING *
    `,
    sql`
      INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
      VALUES (${entityId}, ${actor.id}, 'comment_created',
             ${JSON.stringify({ comment_id: id, ...(parentId ? { parent_id: parentId } : {}) })}::jsonb,
             ${now}::timestamptz)
    `,
  ]);

  backgroundTask(
    fanOutNotifications({
      entity_id: entityId,
      actor_id: actor.id,
      action: "comment_created",
      detail: { comment_id: id, ...(parentId ? { parent_id: parentId } : {}) },
      ts: now,
    }),
  );

  return c.json((rows as Array<Record<string, unknown>>)[0], 201);
});

commentsRouter.openapi(listCommentsRoute, async (c) => {
  const sql = createSql();
  const actorId = c.get("actor")?.id ?? "";
  const entityId = c.req.param("id");
  const limit = parseLimit(c, { defaultValue: 50, maxValue: 200 });
  const cursor = parseCursorParam(c);

  const actorCtx = c.get("actor");
  const [,,,,, topRows, replyRows] = await sql.transaction([
    ...setActorContext(sql, actorCtx),
    sql.query(
      `
        SELECT id, entity_id, author_id, body, parent_id, created_at
        FROM comments
        WHERE entity_id = $1
          AND parent_id IS NULL
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
        ORDER BY created_at DESC, id DESC
        LIMIT $4
      `,
      [entityId, cursor?.t ?? null, cursor?.i ?? null, limit + 1],
    ),
    sql`
      SELECT id, entity_id, author_id, body, parent_id, created_at
      FROM comments
      WHERE entity_id = ${entityId}
        AND parent_id IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `,
  ]);

  const top = (topRows as Array<Record<string, unknown>>).slice(0, limit);
  const repliesByParent = new Map<string, Array<Record<string, unknown>>>();
  for (const reply of replyRows as Array<Record<string, unknown>>) {
    const parent = String(reply.parent_id);
    const list = repliesByParent.get(parent) ?? [];
    list.push(reply);
    repliesByParent.set(parent, list);
  }

  const next = (topRows as Array<Record<string, unknown>>).length > limit ? top[top.length - 1] : null;
  return c.json({
    comments: top.map((row) => ({
      ...row,
      replies: repliesByParent.get(String(row.id)) ?? [],
    })),
    cursor: next ? encodeCursor({ t: next.created_at as string | Date, i: String(next.id) }) : null,
  }, 200);
});

commentsRouter.openapi(deleteCommentRoute, async (c) => {
  const actor = requireActor(c);
  const entityId = c.req.param("id");
  const commentId = c.req.param("commentId");
  const now = new Date().toISOString();
  const sql = createSql();

  const [,,,,, rows] = await sql.transaction([
    ...setActorContext(sql, actor),
    sql.query(
      `
        SELECT c.author_id, e.owner_id,
               (actor_has_entity_role(e.id, ARRAY['admin'])) AS is_entity_admin
        FROM comments c
        JOIN entities e ON e.id = c.entity_id
        WHERE c.id = $1 AND c.entity_id = e.id
        LIMIT 1
      `,
      [commentId],
    ),
  ]);
  const info = (rows as Array<{ author_id: string; owner_id: string; is_entity_admin: boolean }>)[0];
  if (!info) {
    throw new ApiError(404, "not_found", "Comment not found");
  }
  if (info.author_id !== actor.id && info.owner_id !== actor.id && !info.is_entity_admin && !actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Only the comment author, entity owner, or an admin can delete this comment");
  }

  await sql.transaction([
    ...setActorContext(sql, actor),
    sql`DELETE FROM comments WHERE id = ${commentId}`,
    sql`
      INSERT INTO entity_activity (entity_id, actor_id, action, detail, ts)
      VALUES (${entityId}, ${actor.id}, 'comment_deleted',
             ${JSON.stringify({ comment_id: commentId })}::jsonb,
             ${now}::timestamptz)
    `,
  ]);

  backgroundTask(
    fanOutNotifications({
      entity_id: entityId,
      actor_id: actor.id,
      action: "comment_deleted",
      detail: { comment_id: commentId },
      ts: now,
    }),
  );

  return new Response(null, { status: 204 });
});

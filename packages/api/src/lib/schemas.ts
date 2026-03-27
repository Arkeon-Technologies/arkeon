import { z } from "@hono/zod-openapi";
import type { ZodTypeAny } from "zod";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const ISO_DATE_TIME_EXAMPLE = "2026-01-01T00:00:00.000Z";

export const UlidSchema = z
  .string()
  .regex(ULID_PATTERN, "Expected a ULID")
  .openapi({ example: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });

export const EntityIdParam = UlidSchema.describe("ULID string");

export const AccessPolicy = z
  .enum(["public", "private", "collaborators", "contributors", "owner"])
  .openapi("AccessPolicy");

export const ViewAccessPolicy = z.enum(["public", "private"]).openapi("ViewAccessPolicy");
export const EditAccessPolicy = z
  .enum(["public", "collaborators", "owner"])
  .openapi("EditAccessPolicy");
export const ContributeAccessPolicy = z
  .enum(["public", "contributors", "owner"])
  .openapi("ContributeAccessPolicy");

export const DateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .openapi({ example: ISO_DATE_TIME_EXAMPLE });

export const JsonObjectSchema = z.record(z.string(), z.any()).openapi("JsonObject");

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "invalid_body" }),
      message: z.string().openapi({ example: "Invalid request" }),
      details: JsonObjectSchema.optional(),
      request_id: z.string().optional().openapi({ example: "req_123" }),
    }),
  })
  .openapi("ErrorResponse");

export const EntitySchema = z
  .object({
    id: UlidSchema,
    kind: z.string(),
    type: z.string(),
    ver: z.number().int(),
    properties: JsonObjectSchema,
    owner_id: UlidSchema,
    commons_id: UlidSchema.nullable(),
    view_access: ViewAccessPolicy,
    edit_access: EditAccessPolicy,
    contribute_access: ContributeAccessPolicy,
    edited_by: UlidSchema,
    note: z.string().nullable(),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
  })
  .openapi("Entity");

export const EntityResponse = z
  .object({
    entity: EntitySchema,
  })
  .openapi("EntityResponse");

export const CursorSchema = z
  .string()
  .nullable()
  .openapi({ description: "Opaque pagination cursor", example: "eyJ0Ijoi..." });

export function cursorResponseSchema(key: string, itemSchema: ZodTypeAny) {
  return z.object({
    [key]: z.array(itemSchema),
    cursor: CursorSchema,
  });
}

export function pathParam(name: string, schema: ZodTypeAny, description: string) {
  return schema.openapi({
    param: { name, in: "path" },
    description,
  });
}

export function queryParam(name: string, schema: ZodTypeAny, description: string) {
  return schema.openapi({
    param: { name, in: "query" },
    description,
  });
}

export function limitQuerySchema(defaultValue: number, maxValue: number) {
  return queryParam(
    "limit",
    z.coerce.number().int().min(1).max(maxValue).optional(),
    `Max results (default ${defaultValue}, max ${maxValue})`,
  );
}

export function paginationQuerySchema(defaultValue: number, maxValue = 200) {
  return PaginationQuery.extend({
    limit: limitQuerySchema(defaultValue, maxValue),
  });
}

export const PaginationQuery = z.object({
  limit: queryParam(
    "limit",
    z.coerce.number().int().min(1).max(200).optional(),
    "Max results",
  ),
  cursor: queryParam("cursor", z.string().optional(), "Pagination cursor"),
});

export const ProjectionQuery = z.object({
  view: queryParam(
    "view",
    z.enum(["full", "summary"]).optional(),
    "Projection: full | summary",
  ),
  fields: queryParam(
    "fields",
    z.string().min(1).optional(),
    "Comma-separated field list",
  ),
});

export const FilterQuery = z.object({
  filter: queryParam(
    "filter",
    z.string().optional(),
    "Column/property filters. See GET /help for filter syntax.",
  ),
  sort: queryParam("sort", z.string().optional(), "Sort field"),
  order: queryParam("order", z.enum(["asc", "desc"]).optional(), "asc | desc"),
});

export function filterQuerySchema(sortValues: [string, ...string[]], defaultSort: string) {
  return FilterQuery.extend({
    sort: queryParam(
      "sort",
      z.enum(sortValues).optional(),
      `${sortValues.join(" | ")} (default: ${defaultSort})`,
    ),
    order: queryParam(
      "order",
      z.enum(["asc", "desc"]).optional(),
      "asc | desc (default: desc)",
    ),
  });
}

export function entityIdParams(description = "Entity ULID") {
  return z.object({
    id: pathParam("id", EntityIdParam, description),
  });
}

export function jsonContent(schema: ZodTypeAny) {
  return {
    "application/json": {
      schema,
    },
  };
}

const ERROR_STATUS_DESCRIPTIONS: Record<number, string> = {
  400: "Bad request",
  401: "Authentication required",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  410: "Gone",
  413: "Payload too large",
  422: "Validation error",
  500: "Internal server error",
  501: "Not implemented",
};

export function errorResponses(statuses: number[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: ERROR_STATUS_DESCRIPTIONS[status] ?? `Error ${status}`,
        content: jsonContent(ErrorResponse),
      },
    ]),
  );
}

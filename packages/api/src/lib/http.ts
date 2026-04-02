import type { Context } from "hono";

import { ApiError } from "./errors";
import { decodeCursor } from "./cursor";
import type { Actor, AppBindings } from "../types";

export function requireActor(c: Context<AppBindings>) {
  const actor = c.get("actor");
  if (!actor) {
    throw new ApiError(401, "authentication_required", "Authentication required");
  }
  return actor;
}

export function requireAdmin(c: Context<AppBindings>) {
  const actor = requireActor(c);
  if (!actor.isAdmin) {
    throw new ApiError(403, "forbidden", "Admin access required");
  }
  return actor;
}

export function parseLimit(
  c: Context<AppBindings>,
  options: {
    defaultValue: number;
    maxValue: number;
  },
): number {
  const raw = c.req.query("limit");
  if (!raw) {
    return options.defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.maxValue) {
    throw new ApiError(400, "invalid_query", "Invalid limit", {
      limit: raw,
      max: options.maxValue,
    });
  }

  return parsed;
}

export function parseOptionalTimestamp(value: string | undefined, field: string): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "invalid_query", `Invalid ${field}`, {
      field,
      value,
    });
  }

  return date.toISOString();
}

export function parseCursorParam(c: Context<AppBindings>) {
  return decodeCursor(c.req.query("cursor"));
}

export async function parseJsonBody<T>(c: Context<AppBindings>): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

/**
 * Resolve arke_id for create operations.
 * Regular actors: always use their arke_id (body param ignored).
 * Admins (arkeId=null): must pass arke_id explicitly.
 */
export function resolveArkeId(body: Record<string, unknown>, actor: Actor): string {
  if (actor.arkeId) {
    return actor.arkeId;
  }
  if (typeof body.arke_id === "string") {
    return body.arke_id;
  }
  throw new ApiError(
    400,
    "missing_required_field",
    "arke_id is required for admin actors — pass it explicitly or list arkes at GET /arkes",
  );
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    return undefined;
  }
  return value;
}

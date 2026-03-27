import { ApiError } from "./errors";

export type EntityRecord = Record<string, unknown> & {
  id: string;
  kind: string;
  type: string;
  ver: number;
  properties: Record<string, unknown>;
  owner_id: string;
  commons_id: string | null;
  updated_at: string;
  created_at: string;
  view_access: string;
  edit_access: string;
  contribute_access: string;
  edited_by: string;
  note: string | null;
};

export interface CreateEntityInput {
  id: string;
  kind: "commons" | "entity";
  type: string;
  commonsId: string | null;
  properties: Record<string, unknown>;
  ownerId: string;
  viewAccess: string;
  editAccess: string;
  contributeAccess: string;
  now: string;
}

export function validateAccessValue(
  value: unknown,
  field: "view_access" | "edit_access" | "contribute_access",
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_body", `Invalid ${field}`);
  }

  const allowed =
    field === "view_access"
      ? ["public", "private"]
      : field === "edit_access"
        ? ["public", "collaborators", "owner"]
        : ["public", "contributors", "owner"];

  if (!allowed.includes(value)) {
    throw new ApiError(400, "invalid_body", `Invalid ${field}`);
  }

  return value;
}

export function assertBodyObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", `Invalid ${field}`);
  }

  return value as Record<string, unknown>;
}

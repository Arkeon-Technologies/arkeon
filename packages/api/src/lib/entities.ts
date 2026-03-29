import { ApiError } from "./errors";

export type EntityRecord = Record<string, unknown> & {
  id: string;
  kind: string;
  type: string;
  network_id: string;
  ver: number;
  properties: Record<string, unknown>;
  owner_id: string;
  read_level: number;
  write_level: number;
  edited_by: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export function assertBodyObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_body", `Invalid ${field}`);
  }

  return value as Record<string, unknown>;
}

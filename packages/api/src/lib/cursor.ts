import { ApiError } from "./errors";

export interface TimestampCursor {
  t: string | Date;
  i: string | number | bigint;
}

export function decodeCursor(cursor: string | undefined | null): TimestampCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const json = atob(cursor);
    const parsed = JSON.parse(json) as Partial<TimestampCursor>;

    if (!parsed.t || parsed.i === undefined) {
      throw new Error("missing fields");
    }

    return {
      t: String(parsed.t),
      i: typeof parsed.i === "number" ? parsed.i : String(parsed.i),
    };
  } catch {
    throw new ApiError(400, "invalid_cursor", "Invalid cursor");
  }
}

export function encodeCursor(cursor: TimestampCursor | null): string | null {
  if (!cursor) {
    return null;
  }

  const normalized = {
    t: cursor.t instanceof Date ? cursor.t.toISOString() : String(cursor.t),
    i: typeof cursor.i === "bigint" ? cursor.i.toString() : cursor.i,
  };

  return btoa(JSON.stringify(normalized));
}

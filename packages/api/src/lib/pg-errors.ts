import postgres from "postgres";
import { ApiError } from "./errors";

const PgError = postgres.PostgresError;

/** Safe fields to include in API error details — never leak query internals. */
function safeDetails(
  err: InstanceType<typeof PgError>,
): Record<string, unknown> | undefined {
  const d: Record<string, unknown> = {};
  if (err.constraint_name) d.constraint = err.constraint_name;
  if (err.column_name) d.column = err.column_name;
  if (err.table_name) d.table = err.table_name;
  if (err.detail) d.detail = err.detail;
  return Object.keys(d).length > 0 ? d : undefined;
}

function mapPgCode(err: InstanceType<typeof PgError>): ApiError {
  const code = err.code;

  // Class 23 — Integrity constraint violations
  if (code === "23505") {
    return new ApiError(
      409,
      "conflict",
      "A record with this value already exists",
      safeDetails(err),
    );
  }
  if (code === "23503") {
    return new ApiError(
      400,
      "invalid_reference",
      "Referenced record does not exist",
      safeDetails(err),
    );
  }
  if (code === "23502") {
    const col = err.column_name;
    return new ApiError(
      400,
      "missing_field",
      col ? `Required field '${col}' is missing` : "A required field is missing",
      safeDetails(err),
    );
  }
  if (code === "23514") {
    return new ApiError(
      400,
      "validation_error",
      "Value violates a check constraint",
      safeDetails(err),
    );
  }

  // Class 42 — Insufficient privilege (RLS denials)
  if (code === "42501") {
    return new ApiError(403, "forbidden", "Insufficient database privileges");
  }

  // Class 08 — Connection exceptions
  if (code?.startsWith("08")) {
    return new ApiError(
      503,
      "service_unavailable",
      "Database is temporarily unavailable",
    );
  }

  // Unrecognised PG error — return 500 but still typed so it gets logged
  return new ApiError(500, "internal_error", "Internal server error");
}

/**
 * Map a postgres.js error to an ApiError with meaningful status/code.
 * Returns null if the error is not a postgres.js error.
 */
export function mapPostgresError(err: unknown): ApiError | null {
  if (err instanceof PgError) {
    return mapPgCode(err);
  }

  // Connection errors from postgres.js are plain Error objects with errno + address
  if (
    err instanceof Error &&
    "errno" in err &&
    typeof (err as Record<string, unknown>).address === "string"
  ) {
    return new ApiError(
      503,
      "service_unavailable",
      "Database is temporarily unavailable",
    );
  }

  return null;
}

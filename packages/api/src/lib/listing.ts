import { ApiError } from "./errors";
import { buildFilterSql } from "./filtering";
import type { TimestampCursor } from "./cursor";

interface BuildListingQueryOptions {
  filter?: string;
  limit: number;
  cursor: TimestampCursor | null;
  sort: string;
  order: "asc" | "desc";
  spaceId?: string;
}

export function parseOrder(raw: string | undefined): "asc" | "desc" {
  if (!raw || raw === "desc") {
    return "desc";
  }
  if (raw === "asc") {
    return "asc";
  }
  throw new ApiError(400, "invalid_query", "Invalid order", { order: raw });
}

export function parseSort(raw: string | undefined, allowed: string[], defaultSort: string) {
  if (!raw) {
    return defaultSort;
  }
  if (!allowed.includes(raw)) {
    throw new ApiError(400, "invalid_query", "Invalid sort", { sort: raw });
  }
  return raw;
}

/**
 * Merges implicit filters (from the route) with user-supplied filters.
 * Implicit filters are prepended so they always apply.
 *
 * Example: mergeFilters("kind:entity", userFilter) ensures kind=commons
 * even if the user supplies their own filter string.
 */
export function mergeFilters(implicit: string, userFilter?: string): string {
  if (!userFilter) {
    return implicit;
  }
  return `${implicit},${userFilter}`;
}

export function buildEntityListingQuery(options: BuildListingQueryOptions) {
  const params: unknown[] = [];
  const where: string[] = [];
  let nextIndex = 1;

  const filters = buildFilterSql(options.filter, params, nextIndex);
  where.push(...filters.sql);
  nextIndex = filters.nextIndex;

  if (options.spaceId) {
    params.push(options.spaceId);
    where.push(`id IN (SELECT entity_id FROM space_entities WHERE space_id = $${nextIndex})`);
    nextIndex += 1;
  }

  const sortExpr = options.sort;
  const comparator = options.order === "desc" ? "<" : ">";
  const nulls = options.order === "desc" ? "NULLS LAST" : "NULLS FIRST";
  const direction = options.order.toUpperCase();

  if (options.cursor) {
    params.push(options.cursor.t, options.cursor.i);
    where.push(`(${sortExpr}, id) ${comparator} ($${nextIndex}, $${nextIndex + 1})`);
    nextIndex += 2;
  }

  params.push(options.limit + 1);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return {
    query: `
      SELECT *
      FROM entities
      ${whereSql}
      ORDER BY ${sortExpr} ${direction} ${nulls}, id ${direction}
      LIMIT $${nextIndex}
    `,
    params,
  };
}

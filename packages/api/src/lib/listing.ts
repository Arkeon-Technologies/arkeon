import { ApiError } from "./errors";
import { buildFilterSql } from "./filtering";
import type { TimestampCursor } from "./cursor";

interface BuildListingQueryOptions {
  q?: string;
  filter?: string;
  limit: number;
  cursor: TimestampCursor | null;
  sort: string;
  order: "asc" | "desc";
}

function buildSearchSql(q: string | undefined, params: unknown[], startIndex: number) {
  if (!q) {
    return { clauses: [] as string[], nextIndex: startIndex };
  }

  const trimmed = q.trim();
  const clauses: string[] = [];
  let nextIndex = startIndex;

  if (trimmed.startsWith("/") && trimmed.endsWith("/") && trimmed.length > 1) {
    params.push(trimmed.slice(1, -1));
    clauses.push(`properties::text ~ $${nextIndex}`);
    return { clauses, nextIndex: nextIndex + 1 };
  }

  const phrase = trimmed.match(/^"(.*)"$/);
  const terms = phrase ? [phrase[1]] : trimmed.split(/\s+/).filter(Boolean);

  for (const term of terms) {
    params.push(`%${term}%`);
    clauses.push(`properties::text ILIKE $${nextIndex}`);
    nextIndex += 1;
  }

  return { clauses, nextIndex };
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
 * Example: mergeFilters("kind:commons", userFilter) ensures kind=commons
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

  const search = buildSearchSql(options.q, params, nextIndex);
  where.push(...search.clauses);
  nextIndex = search.nextIndex;

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

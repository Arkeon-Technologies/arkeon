import { ApiError } from "./errors";

const FILTER_RE = /^([a-zA-Z_][a-zA-Z0-9_.]*)(!:|!\?|>=|<=|>|<|:|\?)(.*)$/;

export interface FilterClause {
  path: string;
  op: string;
  value: string;
}

// Top-level entity columns exposed to the filter API.
// If a filter path matches one of these, it targets the column directly
// instead of drilling into the properties JSONB.
const COLUMN_WHITELIST: Record<string, "text" | "numeric" | "timestamp"> = {
  kind: "text",
  type: "text",
  arke_id: "text",
  ver: "numeric",
  owner_id: "text",
  read_level: "numeric",
  write_level: "numeric",
  edited_by: "text",
  created_at: "timestamp",
  updated_at: "timestamp",
};

/** Column names available in the filter API, exported for help docs. */
export const FILTERABLE_COLUMNS = Object.entries(COLUMN_WHITELIST).map(
  ([name, type]) => ({ name, type }),
);

export function parseFilter(filter: string | undefined): FilterClause[] {
  if (!filter) {
    return [];
  }

  return filter.split(",").map((expression) => {
    const trimmed = expression.trim();
    const match = trimmed.match(FILTER_RE);
    if (!match) {
      throw new ApiError(400, "invalid_filter", "Invalid filter expression", {
        filter: trimmed,
      });
    }

    const [, path, op, value] = match;
    return { path, op, value };
  });
}

function jsonPathArray(path: string): string {
  return `{${path.split(".").join(",")}}`;
}

/** Returns true if value is a JSON literal (boolean, null, or number). */
function isJsonLiteral(value: string): boolean {
  return (
    value === "true" ||
    value === "false" ||
    value === "null" ||
    (value !== "" && isFinite(Number(value)))
  );
}

function buildColumnClause(
  column: string,
  columnType: "text" | "numeric" | "timestamp",
  op: string,
  value: string,
  params: unknown[],
  paramIndex: number,
): { sql: string; nextIndex: number } {
  switch (op) {
    case ":":
      params.push(value);
      return { sql: `${column} = $${paramIndex}`, nextIndex: paramIndex + 1 };
    case "!:":
      params.push(value);
      return { sql: `${column} != $${paramIndex}`, nextIndex: paramIndex + 1 };
    case ">":
    case ">=":
    case "<":
    case "<=":
      if (columnType === "text") {
        throw new ApiError(400, "invalid_filter", `Numeric/timestamp operator ${op} not supported on text column ${column}`);
      }
      params.push(value);
      if (columnType === "timestamp") {
        return { sql: `${column} ${op} $${paramIndex}::timestamptz`, nextIndex: paramIndex + 1 };
      }
      return { sql: `${column} ${op} $${paramIndex}::numeric`, nextIndex: paramIndex + 1 };
    case "?":
      return { sql: `${column} IS NOT NULL`, nextIndex: paramIndex };
    case "!?":
      return { sql: `${column} IS NULL`, nextIndex: paramIndex };
    default:
      throw new ApiError(400, "invalid_filter", "Invalid filter operator", {
        filter: `${column}${op}${value}`,
      });
  }
}

export function buildFilterSql(
  filter: string | undefined,
  params: unknown[],
  startIndex: number,
): { sql: string[]; nextIndex: number } {
  const clauses = parseFilter(filter);
  const sql: string[] = [];
  let nextIndex = startIndex;

  for (const clause of clauses) {
    const columnType = COLUMN_WHITELIST[clause.path];

    if (columnType) {
      // Top-level column filter
      const result = buildColumnClause(
        clause.path,
        columnType,
        clause.op,
        clause.value,
        params,
        nextIndex,
      );
      sql.push(result.sql);
      nextIndex = result.nextIndex;
      continue;
    }

    // Property JSONB filter
    const pathText = jsonPathArray(clause.path);
    switch (clause.op) {
      case ":":
        params.push(clause.value);
        if (isJsonLiteral(clause.value)) {
          sql.push(`properties #> '${pathText}' = $${nextIndex}::jsonb`);
        } else {
          sql.push(`properties #>> '${pathText}' = $${nextIndex}`);
        }
        nextIndex += 1;
        break;
      case "!:":
        params.push(clause.value);
        if (isJsonLiteral(clause.value)) {
          sql.push(`properties #> '${pathText}' != $${nextIndex}::jsonb`);
        } else {
          sql.push(`properties #>> '${pathText}' != $${nextIndex}`);
        }
        nextIndex += 1;
        break;
      case ">":
      case ">=":
      case "<":
      case "<=":
        params.push(clause.value);
        sql.push(`(properties #>> '${pathText}')::numeric ${clause.op} $${nextIndex}`);
        nextIndex += 1;
        break;
      case "?":
        sql.push(`properties #> '${pathText}' IS NOT NULL`);
        break;
      case "!?":
        sql.push(`properties #> '${pathText}' IS NULL`);
        break;
      default:
        throw new ApiError(400, "invalid_filter", "Invalid filter expression", {
          filter: `${clause.path}${clause.op}${clause.value}`,
        });
    }
  }

  return { sql, nextIndex };
}

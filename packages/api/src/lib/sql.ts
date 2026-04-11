// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import postgres from "postgres";

type Row = Record<string, unknown>;

interface QueryDescriptor {
  _kind: "tagged" | "parameterized";
  _strings?: TemplateStringsArray;
  _values?: unknown[];
  _text?: string;
  _params?: unknown[];
  then<T1 = Row[], T2 = never>(
    onfulfilled?: ((value: Row[]) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2>;
}

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: unknown[]): QueryDescriptor;
  query(text: string, params?: unknown[]): QueryDescriptor;
  transaction(queries: QueryDescriptor[]): Promise<Row[][]>;
}

/**
 * postgres.js .unsafe() sends string params as text, so a JSON.stringify'd
 * object passed to a ::jsonb column becomes a JSON *string* rather than a
 * JSON object. Pre-parse JSON string params back into objects so postgres.js
 * serializes them correctly.
 */
function prepareParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (typeof p !== "string") return p;
    const ch = p[0];
    if (ch !== "{" && ch !== "[") return p;
    try {
      return JSON.parse(p);
    } catch {
      return p;
    }
  });
}

const DEFAULT_DATABASE_URL = "postgresql://arke_app:arke@localhost:5432/arke";

let _pg: postgres.Sql | null = null;

function getPg(): postgres.Sql {
  if (!_pg) {
    _pg = postgres(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  }
  return _pg;
}

/**
 * Run a callback inside a transaction with a scoped sql client.
 * Guarantees all queries in the callback use the same connection.
 * Automatically commits on success, rolls back on error.
 */
export async function withTransaction<T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> {
  const pg = getPg();
  return pg.begin(async (tx) => {
    // Wrap the transaction-scoped `tx` in our SqlClient interface
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => ({
      _kind: "tagged" as const,
      _strings: strings,
      _values: values,
      then(onfulfilled: any, onrejected: any) {
        return (tx as any)(strings, ...values).then(
          (r: unknown) => onfulfilled?.(r as Row[]),
          onrejected,
        );
      },
    })) as unknown as SqlClient;

    sql.query = (text: string, params: unknown[] = []) => ({
      _kind: "parameterized" as const,
      _text: text,
      _params: params,
      then(onfulfilled: any, onrejected: any) {
        return (tx as any).unsafe(text, prepareParams(params) as any[]).then(
          (r: unknown) => onfulfilled?.(r as Row[]),
          onrejected,
        );
      },
    });

    sql.transaction = async (descriptors) => {
      // Already in a transaction — just execute sequentially
      const results: Row[][] = [];
      for (const desc of descriptors) {
        if (desc._kind === "tagged") {
          const r = await (tx as any)(desc._strings, ...desc._values!);
          results.push(r as unknown as Row[]);
        } else {
          const r = await (tx as any).unsafe(desc._text, prepareParams(desc._params!));
          results.push(r as unknown as Row[]);
        }
      }
      return results;
    };

    return fn(sql);
  }) as T;
}

export function createSql(): SqlClient {
  const pg = getPg();

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => ({
    _kind: "tagged" as const,
    _strings: strings,
    _values: values,
    then(onfulfilled: any, onrejected: any) {
      return (pg as any)(strings, ...values).then(
        (r: unknown) => onfulfilled?.(r as Row[]),
        onrejected,
      );
    },
  })) as unknown as SqlClient;

  sql.query = (text: string, params: unknown[] = []) => ({
    _kind: "parameterized" as const,
    _text: text,
    _params: params,
    then(onfulfilled: any, onrejected: any) {
      return (pg as any).unsafe(text, prepareParams(params) as any[]).then(
        (r: unknown) => onfulfilled?.(r as Row[]),
        onrejected,
      );
    },
  });

  sql.transaction = async (descriptors) => {
    return pg.begin(async (tx) => {
      const results: Row[][] = [];
      for (const desc of descriptors) {
        if (desc._kind === "tagged") {
          const r = await (tx as any)(desc._strings, ...desc._values!);
          results.push(r as unknown as Row[]);
        } else {
          const r = await (tx as any).unsafe(desc._text, prepareParams(desc._params!));
          results.push(r as unknown as Row[]);
        }
      }
      return results;
    });
  };

  return sql;
}

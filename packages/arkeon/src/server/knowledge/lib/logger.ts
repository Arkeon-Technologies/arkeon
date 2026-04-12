// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge job logger — writes job logs and token usage to Postgres.
 * Fire-and-forget pattern: log calls don't block the pipeline.
 */

import { withAdminSql } from "./admin-sql";
import type { LlmUsage } from "./llm";

export type LogKind =
  | "llm_request"
  | "llm_response"
  | "tool_call"
  | "tool_result"
  | "error"
  | "info";

// Scrub potential secrets from log content
const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /uk_[a-zA-Z0-9]{20,}/g,
  /ak_[a-zA-Z0-9_]{10,}/g,
  /key-[a-zA-Z0-9]{20,}/g,
  /"api_key"\s*:\s*"[^"]+"/g,
  /"api_key_enc(rypted)?"\s*:\s*"[^"]+"/g,
];

function scrubSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.startsWith('"api_key"')) return '"api_key":"[REDACTED]"';
      if (match.startsWith('"api_key_enc')) return '"api_key_encrypted":"[REDACTED]"';
      return match.slice(0, 8) + "...[REDACTED]";
    });
  }
  return result;
}

const seqCounters = new Map<string, number>();

/**
 * Remove the sequence counter for a completed/failed job to prevent memory leaks.
 */
export function clearJobSeq(jobId: string): void {
  seqCounters.delete(jobId);
}

/**
 * Append a log entry for a knowledge job. Fire-and-forget.
 */
export function appendLog(
  jobId: string,
  kind: LogKind,
  content: unknown,
  usage?: LlmUsage,
): void {
  const seq = (seqCounters.get(jobId) ?? 0) + 1;
  seqCounters.set(jobId, seq);

  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const scrubbed = scrubSecrets(raw);

  // Fire-and-forget: write log + token rollup inside one admin tx so the
  // set_config and inserts share a single connection.
  withAdminSql(async (sql) => {
    await sql.query(
      `INSERT INTO knowledge_job_logs (job_id, seq, ts, kind, content, model, tokens_in, tokens_out)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7)`,
      [
        jobId,
        seq,
        kind,
        scrubbed,
        usage?.model ?? null,
        usage?.tokensIn ?? null,
        usage?.tokensOut ?? null,
      ],
    );

    if (usage && (usage.tokensIn > 0 || usage.tokensOut > 0)) {
      await sql.query(
        `INSERT INTO knowledge_token_usage (date, model, calls, tokens_in, tokens_out)
         VALUES (CURRENT_DATE, $1, 1, $2, $3)
         ON CONFLICT (date, model) DO UPDATE SET
           calls = knowledge_token_usage.calls + 1,
           tokens_in = knowledge_token_usage.tokens_in + EXCLUDED.tokens_in,
           tokens_out = knowledge_token_usage.tokens_out + EXCLUDED.tokens_out`,
        [usage.model, usage.tokensIn, usage.tokensOut],
      );
    }
  }).catch((err: unknown) => {
    console.error(`[knowledge:logger] Failed to write log for job ${jobId}:`, err);
  });
}

/**
 * Get logs for a specific job.
 */
export async function getJobLogs(
  jobId: string,
  opts?: { limit?: number; offset?: number },
): Promise<Array<{
  id: number;
  seq: number;
  ts: string;
  kind: string;
  content: unknown;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
}>> {
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;

  const rows = await withAdminSql(async (sql) =>
    await sql.query(
      `SELECT id, seq, ts, kind, content, model, tokens_in, tokens_out
       FROM knowledge_job_logs
       WHERE job_id = $1
       ORDER BY seq
       LIMIT $2 OFFSET $3`,
      [jobId, limit, offset],
    ),
  );

  return rows.map((r) => ({
    id: r.id as number,
    seq: r.seq as number,
    ts: (r.ts as Date).toISOString(),
    kind: r.kind as string,
    content: r.content,
    model: r.model as string | null,
    tokens_in: r.tokens_in as number | null,
    tokens_out: r.tokens_out as number | null,
  }));
}

/**
 * Get token usage summary for a date range.
 */
export async function getTokenUsage(opts: {
  from: string;
  to: string;
}): Promise<{
  totals: { calls: number; tokens_in: number; tokens_out: number };
  by_model: Record<string, { calls: number; tokens_in: number; tokens_out: number }>;
}> {
  const rows = await withAdminSql(async (sql) =>
    await sql.query(
      `SELECT model, SUM(calls)::int as calls, SUM(tokens_in)::int as tokens_in, SUM(tokens_out)::int as tokens_out
       FROM knowledge_token_usage
       WHERE date >= $1::date AND date <= $2::date
       GROUP BY model`,
      [opts.from, opts.to],
    ),
  );

  const totals = { calls: 0, tokens_in: 0, tokens_out: 0 };
  const by_model: Record<string, { calls: number; tokens_in: number; tokens_out: number }> = {};

  for (const row of rows) {
    const model = row.model as string;
    const calls = row.calls as number;
    const tokensIn = row.tokens_in as number;
    const tokensOut = row.tokens_out as number;

    totals.calls += calls;
    totals.tokens_in += tokensIn;
    totals.tokens_out += tokensOut;

    by_model[model] = { calls, tokens_in: tokensIn, tokens_out: tokensOut };
  }

  return { totals, by_model };
}

// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge extraction configuration backed by Postgres.
 * Handles LLM config resolution (with fallback chain) and extraction rules.
 */

import { encrypt, decrypt, keyHint } from "../../lib/crypto";
import { withAdminSql } from "./admin-sql";
import type { LlmConfig } from "./llm";

export interface StoredLlmConfig {
  id: string;
  provider: string;
  base_url: string | null;
  api_key_hint: string | null;
  model: string;
  max_tokens: number;
  updated_at: string;
  has_key: boolean;
}

export interface ExtractionConfig {
  entity_types: string[];
  strict_entity_types: boolean;
  predicates: string[];
  strict_predicates: boolean;
  custom_instructions: string | null;
  max_concurrency: number;
  target_chunk_chars: number;
  scope_to_space: boolean;
  updated_at: string;
}

/**
 * Resolve LLM config for a given agent role.
 *
 * Looks up `knowledge_config` for the agent-specific id first, then "default".
 * Returns the first row that has both a stored API key and a base URL. There
 * is no env-var fallback and no provider-specific default — every field must
 * be explicitly configured. Configure via `arkeon init`, the dashboard, or
 * `PUT /knowledge/config`.
 */
export async function resolveLlmConfig(agentId: string): Promise<LlmConfig> {
  return withAdminSql(async (sql) => {
    for (const id of [agentId, "default"]) {
      const [row] = await sql`
        SELECT provider, base_url, api_key_encrypted, model, max_tokens
        FROM knowledge_config
        WHERE id = ${id}
      `;

      if (row?.api_key_encrypted && row.base_url) {
        const apiKey = await decrypt(row.api_key_encrypted as string);
        return {
          baseUrl: row.base_url as string,
          apiKey,
          model: row.model as string,
          maxTokens: row.max_tokens as number,
        };
      }
    }

    throw new Error(
      `No LLM provider configured for "${agentId}". Run \`arkeon init\` or PUT /knowledge/config with provider, base_url, api_key, and model.`,
    );
  });
}

/**
 * Save or update LLM config for a given agent role.
 */
export async function saveLlmConfig(
  id: string,
  opts: {
    provider: string;
    base_url?: string;
    api_key?: string;
    model: string;
    max_tokens?: number;
  },
): Promise<void> {
  const apiKeyEncrypted = opts.api_key ? await encrypt(opts.api_key) : null;
  const apiKeyHintVal = opts.api_key ? keyHint(opts.api_key) : null;

  await withAdminSql(async (sql) => {
    if (apiKeyEncrypted) {
      await sql.query(
        `INSERT INTO knowledge_config (id, provider, base_url, api_key_encrypted, api_key_hint, model, max_tokens, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           provider = EXCLUDED.provider,
           base_url = EXCLUDED.base_url,
           api_key_encrypted = EXCLUDED.api_key_encrypted,
           api_key_hint = EXCLUDED.api_key_hint,
           model = EXCLUDED.model,
           max_tokens = EXCLUDED.max_tokens,
           updated_at = NOW()`,
        [id, opts.provider, opts.base_url ?? null, apiKeyEncrypted, apiKeyHintVal, opts.model, opts.max_tokens ?? 4096],
      );
    } else {
      // Update without changing the key
      await sql.query(
        `INSERT INTO knowledge_config (id, provider, base_url, model, max_tokens, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET
           provider = EXCLUDED.provider,
           base_url = EXCLUDED.base_url,
           model = EXCLUDED.model,
           max_tokens = EXCLUDED.max_tokens,
           updated_at = NOW()`,
        [id, opts.provider, opts.base_url ?? null, opts.model, opts.max_tokens ?? 4096],
      );
    }
  });
}

/**
 * List all configured LLM configs (keys redacted).
 */
export async function listLlmConfigs(): Promise<StoredLlmConfig[]> {
  return withAdminSql(async (sql) => {
    const rows = await sql`
      SELECT id, provider, base_url, api_key_hint, model, max_tokens, updated_at, api_key_encrypted
      FROM knowledge_config
      ORDER BY id
    `;

    return rows.map((r) => ({
      id: r.id as string,
      provider: r.provider as string,
      base_url: r.base_url as string | null,
      api_key_hint: r.api_key_hint as string | null,
      model: r.model as string,
      max_tokens: r.max_tokens as number,
      updated_at: (r.updated_at as Date).toISOString(),
      has_key: r.api_key_encrypted != null,
    }));
  });
}

/**
 * Delete an LLM config.
 */
export async function deleteLlmConfig(id: string): Promise<boolean> {
  return withAdminSql(async (sql) => {
    const rows = await sql`DELETE FROM knowledge_config WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  });
}

// --- Extraction config ---

export async function getExtractionConfig(): Promise<ExtractionConfig> {
  return withAdminSql(async (sql) => {
    const [row] = await sql`
      SELECT entity_types, strict_entity_types, predicates, strict_predicates, custom_instructions, max_concurrency, target_chunk_chars, scope_to_space, updated_at
      FROM extraction_config
      WHERE id = 'default'
    `;

    if (!row) {
      return {
        entity_types: ["person", "organization", "location", "event", "concept", "document", "product", "technology"],
        strict_entity_types: false,
        predicates: ["relates_to", "part_of", "leads", "works_at", "located_in", "participated_in", "created", "references", "depends_on", "preceded_by"],
        strict_predicates: false,
        custom_instructions: null,
        max_concurrency: 10,
        target_chunk_chars: 8000,
        scope_to_space: true,
        updated_at: new Date().toISOString(),
      };
    }

    return {
      entity_types: row.entity_types as string[],
      strict_entity_types: row.strict_entity_types as boolean,
      predicates: row.predicates as string[],
      strict_predicates: row.strict_predicates as boolean,
      custom_instructions: row.custom_instructions as string | null,
      max_concurrency: (row.max_concurrency as number) ?? 10,
      target_chunk_chars: (row.target_chunk_chars as number) ?? 8000,
      scope_to_space: (row.scope_to_space as boolean) ?? true,
      updated_at: (row.updated_at as Date).toISOString(),
    };
  });
}

export async function saveExtractionConfig(opts: {
  entity_types?: string[];
  strict_entity_types?: boolean;
  predicates?: string[];
  strict_predicates?: boolean;
  custom_instructions?: string | null;
  max_concurrency?: number;
  target_chunk_chars?: number;
  scope_to_space?: boolean;
}): Promise<ExtractionConfig> {
  const current = await getExtractionConfig();

  const entityTypes = opts.entity_types ?? current.entity_types;
  const strictEntityTypes = opts.strict_entity_types ?? current.strict_entity_types;
  const predicates = opts.predicates ?? current.predicates;
  const strictPredicates = opts.strict_predicates ?? current.strict_predicates;
  const customInstructions = opts.custom_instructions !== undefined
    ? opts.custom_instructions
    : current.custom_instructions;
  const maxConcurrency = opts.max_concurrency ?? current.max_concurrency;
  const targetChunkChars = opts.target_chunk_chars ?? current.target_chunk_chars;
  const scopeToSpace = opts.scope_to_space ?? current.scope_to_space;

  await withAdminSql(async (sql) => {
    await sql.query(
      `INSERT INTO extraction_config (id, entity_types, strict_entity_types, predicates, strict_predicates, custom_instructions, max_concurrency, target_chunk_chars, scope_to_space, updated_at)
       VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         entity_types = EXCLUDED.entity_types,
         strict_entity_types = EXCLUDED.strict_entity_types,
         predicates = EXCLUDED.predicates,
         strict_predicates = EXCLUDED.strict_predicates,
         custom_instructions = EXCLUDED.custom_instructions,
         max_concurrency = EXCLUDED.max_concurrency,
         target_chunk_chars = EXCLUDED.target_chunk_chars,
         scope_to_space = EXCLUDED.scope_to_space,
         updated_at = NOW()`,
      [JSON.stringify(entityTypes), strictEntityTypes, JSON.stringify(predicates), strictPredicates, customInstructions ?? null, maxConcurrency, targetChunkChars, scopeToSpace],
    );
  });

  return {
    entity_types: entityTypes,
    strict_entity_types: strictEntityTypes,
    predicates,
    strict_predicates: strictPredicates,
    custom_instructions: customInstructions,
    max_concurrency: maxConcurrency,
    target_chunk_chars: targetChunkChars,
    scope_to_space: scopeToSpace,
    updated_at: new Date().toISOString(),
  };
}

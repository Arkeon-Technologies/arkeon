// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "postgresql://arke:arke@localhost:5432/arke";
// Migrations need superuser (for SECURITY DEFINER, RLS policy changes, etc.)
// Use MIGRATION_DATABASE_URL or DATABASE_URL or CLI arg
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? process.argv[2] ?? DEFAULT_URL;

// Template variables substituted into .sql files before execution. Tokens
// of the form :'name' are replaced with a SQL-quoted literal of the
// matching value. The default for arke_app_password keeps ad-hoc
// `node migrate.js` runs (intentionally using the weak `arke` password)
// working without extra config; the arkeon CLI passes a real value via
// ARKE_APP_PASSWORD from ~/.arkeon/secrets.json.
const TEMPLATE_VARS = {
  arke_app_password: process.env.ARKE_APP_PASSWORD ?? "arke",
};

function quoteSqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function applyTemplate(content, file) {
  // Replace :'name' tokens. The set of recognized names is fixed by
  // TEMPLATE_VARS — anything else is a typo and should fail loudly
  // rather than send broken SQL to Postgres.
  return content.replace(/:'([a-zA-Z_][a-zA-Z0-9_]*)'/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(TEMPLATE_VARS, name)) {
      throw new Error(
        `${file}: unknown template variable :'${name}'. Known: ${Object.keys(TEMPLATE_VARS).join(", ")}`,
      );
    }
    return quoteSqlLiteral(TEMPLATE_VARS[name]);
  });
}

console.log(`Deploying schema to: ${url.replace(/:[^@]*@/, ":***@")}`);
console.log("");

const sql = postgres(url);
const files = (await readdir(__dirname))
  .filter((f) => f.endsWith(".sql"))
  .sort();

let failed = false;

/**
 * Split a SQL file into individual statements. Handles:
 * - $$ dollar-quoted blocks (functions, cron jobs)
 * - -- line comments (semicolons inside are ignored)
 * - Single-quoted strings
 */
function splitStatements(content) {
  const statements = [];
  let current = "";
  let inDollarQuote = false;
  let inLineComment = false;
  let inString = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    // Line comment ends at newline
    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    // Start of line comment
    if (!inDollarQuote && !inString && ch === "-" && content[i + 1] === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }

    // Dollar quoting toggle
    if (!inString && ch === "$" && content[i + 1] === "$") {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i++;
      continue;
    }

    // String quoting
    if (!inDollarQuote && ch === "'") {
      inString = !inString;
      current += ch;
      continue;
    }

    // Statement delimiter
    if (ch === ";" && !inDollarQuote && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}

for (const file of files) {
  const rawContent = await readFile(join(__dirname, file), "utf-8");
  const content = applyTemplate(rawContent, file);
  const statements = splitStatements(content);
  process.stdout.write(`  ${file} ... `);

  let fileOk = true;
  let skipped = false;

  for (const stmt of statements) {
    // Skip comment-only blocks
    if (stmt.replace(/--[^\n]*/g, "").trim() === "") continue;

    try {
      await sql.unsafe(stmt);
    } catch (err) {
      const msg = err.message ?? "";
      if (err.code === "42P07" || msg.includes("already exists")) {
        skipped = true;
      } else if (err.code === "42703" && msg.includes("does not exist")) {
        // Column was renamed by a later migration — index already covers it
        skipped = true;
      } else {
        console.log(`ERROR: ${msg}`);
        fileOk = false;
        failed = true;
        break;
      }
    }
  }

  if (fileOk) {
    console.log(skipped ? "OK (exists)" : "OK");
  }
}

console.log("");
await sql.end();

if (failed) {
  console.error("Schema deployment had errors. Review output above.");
  process.exit(1);
} else {
  console.log("Schema deployed successfully.");
}

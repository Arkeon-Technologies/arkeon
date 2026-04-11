// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local runtime for the Arkeon stack.
 *
 * Manages the three things `arkeon start` needs to turn up a working
 * Arkeon instance with no Docker and no system-installed services:
 *
 *   1. ~/.arkeon/           — state directory (data, binaries, secrets, pidfile)
 *   2. embedded Postgres    — runs as a child process, data in ~/.arkeon/data/postgres
 *   3. Meilisearch          — binary downloaded on first run, data in ~/.arkeon/data/meili
 *
 * Plus secrets (ADMIN_BOOTSTRAP_KEY, ENCRYPTION_KEY, MEILI_MASTER_KEY) that
 * are generated on first run and persisted in ~/.arkeon/secrets.json so
 * subsequent starts don't rotate keys on users.
 *
 * This module is runtime-only — it doesn't import the API server or
 * tie into startApi(). The `arkeon start` command orchestrates the two.
 */

import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";

import EmbeddedPostgres from "embedded-postgres";

// =====================================================================
// Paths + conventions
// =====================================================================
//
// Paths are exposed as getter functions rather than module-level constants
// so that commands can set `process.env.ARKEON_HOME` (or its --data-dir
// CLI equivalent) at action time and have the subsequent calls observe
// the override. Constants captured at module import time would lock in
// whatever ARKEON_HOME was when the CLI first loaded this module.

function arkeonHome(): string {
  return process.env.ARKEON_HOME ?? join(homedir(), ".arkeon");
}

export function arkeonDir(): string { return arkeonHome(); }
export function dataDir(): string { return join(arkeonHome(), "data"); }
export function pgDataDir(): string { return join(dataDir(), "postgres"); }
export function meiliDataDir(): string { return join(dataDir(), "meili"); }
export function filesDataDir(): string { return join(dataDir(), "files"); }
export function binDir(): string { return join(arkeonHome(), "bin"); }
export function secretsFile(): string { return join(arkeonHome(), "secrets.json"); }
export function pidfile(): string { return join(arkeonHome(), "arkeon.pid"); }
export function logfile(): string { return join(arkeonHome(), "arkeon.log"); }

// Meilisearch version pinned for reproducibility. Bump deliberately.
const MEILI_VERSION = "v1.41.0";

// Default ports. Users can override via env.
export const DEFAULT_API_PORT = 8000;
export const DEFAULT_PG_PORT = 5433; // 5433 not 5432 so we don't collide with a user's system Postgres
export const DEFAULT_MEILI_PORT = 7700;

// =====================================================================
// Directory bootstrap
// =====================================================================

export function ensureArkeonDir(): void {
  for (const dir of [arkeonDir(), dataDir(), binDir(), filesDataDir()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// =====================================================================
// Secrets — generated once, persisted forever
// =====================================================================

export interface ArkeonSecrets {
  adminBootstrapKey: string;
  encryptionKey: string;
  meiliMasterKey: string;
  // Runtime Postgres password. This one doesn't need to be "secret" in
  // the traditional sense — the DB only listens on localhost — but we
  // still generate a random one so the data dir isn't trivially
  // accessible by other users on a shared machine.
  pgPassword: string;
}

export function loadOrCreateSecrets(): ArkeonSecrets {
  const path = secretsFile();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ArkeonSecrets;
      // Forward-compat: if someone's old secrets.json is missing a new
      // field we added later, fill it in and rewrite.
      const complete: ArkeonSecrets = {
        adminBootstrapKey: parsed.adminBootstrapKey ?? `ak_${randomBytes(32).toString("hex")}`,
        encryptionKey: parsed.encryptionKey ?? randomBytes(32).toString("hex"),
        meiliMasterKey: parsed.meiliMasterKey ?? randomBytes(24).toString("hex"),
        pgPassword: parsed.pgPassword ?? randomBytes(16).toString("hex"),
      };
      if (JSON.stringify(parsed) !== JSON.stringify(complete)) {
        writeFileSync(path, JSON.stringify(complete, null, 2), { mode: 0o600 });
      }
      return complete;
    } catch {
      // Fall through to regenerate — a corrupt secrets file is a bigger
      // problem the user has to know about via reset.
      throw new Error(
        `Failed to parse ${path}. Delete it and run \`arkeon start\` again to regenerate.`,
      );
    }
  }

  const secrets: ArkeonSecrets = {
    adminBootstrapKey: `ak_${randomBytes(32).toString("hex")}`,
    encryptionKey: randomBytes(32).toString("hex"),
    meiliMasterKey: randomBytes(24).toString("hex"),
    pgPassword: randomBytes(16).toString("hex"),
  };
  writeFileSync(path, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  return secrets;
}

// =====================================================================
// Meilisearch binary lifecycle
// =====================================================================

function meiliAssetName(): string {
  const p = platform();
  const a = arch();
  if (p === "linux") {
    if (a === "x64") return "meilisearch-linux-amd64";
    if (a === "arm64") return "meilisearch-linux-aarch64";
  } else if (p === "darwin") {
    if (a === "x64") return "meilisearch-macos-amd64";
    if (a === "arm64") return "meilisearch-macos-apple-silicon";
  } else if (p === "win32") {
    if (a === "x64") return "meilisearch-windows-amd64.exe";
  }
  throw new Error(
    `Unsupported platform for Meilisearch binary: ${p}/${a}. ` +
    `Supported: linux x64/arm64, darwin x64/arm64, win32 x64.`,
  );
}

export function meiliBinaryPath(): string {
  const name = platform() === "win32" ? "meilisearch.exe" : "meilisearch";
  return join(binDir(), name);
}

export async function ensureMeiliBinary(): Promise<string> {
  const target = meiliBinaryPath();
  if (existsSync(target)) {
    try {
      if (statSync(target).size > 0) return target;
    } catch {
      // fall through to re-download
    }
  }

  const asset = meiliAssetName();
  const url = `https://github.com/meilisearch/meilisearch/releases/download/${MEILI_VERSION}/${asset}`;
  console.log(`[arkeon] Downloading Meilisearch ${MEILI_VERSION} for ${platform()}/${arch()}`);
  console.log(`         ${url}`);

  // Node's global fetch handles redirects; GitHub uses CDN redirect for release assets.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Meilisearch: ${response.status} ${response.statusText}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  // Write to a .part file first, then rename — so an interrupted download
  // doesn't leave a truncated binary that looks "installed" on next run.
  const partPath = `${target}.part`;
  const out = createWriteStream(partPath);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, out);

  // Sanity-check size. Meilisearch binaries are ~100MB; anything under 1MB
  // is almost certainly an error page, not a binary.
  const size = statSync(partPath).size;
  if (size < 1024 * 1024) {
    unlinkSync(partPath);
    throw new Error(
      `Downloaded Meilisearch asset was only ${size} bytes — expected a binary. ` +
      `Check your network or retry.`,
    );
  }

  // Rename into place and make it executable on POSIX.
  if (existsSync(target)) unlinkSync(target);
  renameSync(partPath, target);
  if (platform() !== "win32") chmodSync(target, 0o755);

  console.log(`[arkeon] Meilisearch binary installed at ${target}`);
  return target;
}

export function startMeilisearch(opts: {
  port: number;
  masterKey: string;
}): ChildProcess {
  const dbPath = meiliDataDir();
  if (!existsSync(dbPath)) mkdirSync(dbPath, { recursive: true });
  const bin = meiliBinaryPath();
  const child = spawn(
    bin,
    [
      "--db-path",
      dbPath,
      "--http-addr",
      `127.0.0.1:${opts.port}`,
      "--master-key",
      opts.masterKey,
      "--no-analytics",
      "--env",
      "development",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  child.stdout?.on("data", (chunk: Buffer) => {
    // Meilisearch is chatty on startup; prefix so it's obvious which
    // process is speaking in the arkeon log.
    process.stdout.write(`[meili] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[meili] ${chunk.toString()}`);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[meili] exited with code ${code} (signal ${signal})`);
    }
  });

  return child;
}

export async function waitForMeilisearchReady(
  port: number,
  masterKey: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${masterKey}` },
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Meilisearch did not become healthy within ${timeoutMs}ms`);
}

// =====================================================================
// Embedded Postgres lifecycle
// =====================================================================

export interface PgHandle {
  /** Connection string for the runtime application role (arke_app). */
  appUrl: string;
  /** Connection string for the superuser (used for migrations). */
  superUrl: string;
  /** Stop the server. */
  stop: () => Promise<void>;
}

export async function startEmbeddedPostgres(opts: {
  port: number;
  password: string;
}): Promise<PgHandle> {
  const pgData = pgDataDir();
  const alreadyInitialised = existsSync(join(pgData, "PG_VERSION"));

  // embedded-postgres stores data in `databaseDir`. If this is the first
  // start, it runs initdb; subsequent starts reuse the existing cluster.
  const pg = new EmbeddedPostgres({
    databaseDir: pgData,
    user: "arke",
    password: opts.password,
    port: opts.port,
    persistent: true,
  });

  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();

  // First-run only: create the `arke` database owned by the `arke` user.
  // embedded-postgres creates a default `postgres` database; our schema
  // lives in `arke` to match production layout.
  if (!alreadyInitialised) {
    try {
      await pg.createDatabase("arke");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("already exists")) throw err;
    }
  }

  // The arke_app role is created by packages/schema/001-roles.sql at
  // migration time, so we don't create it here. The migration reads
  // its password from ARKE_APP_PASSWORD, which the caller must set.
  //
  // For the runtime application URL, we build a string that will work
  // *after* migrations run. During migrations, the caller uses superUrl.
  const superUrl = `postgresql://arke:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/arke`;
  const appUrl = `postgresql://arke_app:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/arke`;

  return {
    appUrl,
    superUrl,
    stop: async () => {
      try {
        await pg.stop();
      } catch (err) {
        console.warn("[pg] stop error:", (err as Error).message);
      }
    },
  };
}

// =====================================================================
// Worker toolchain check — warn but don't block
// =====================================================================

export function checkWorkerToolchain(): void {
  const tools = ["bash", "curl", "jq", "python3"];
  const missing: string[] = [];
  for (const tool of tools) {
    const r = spawnSync(tool, ["--version"], { stdio: "ignore" });
    if (r.status !== 0) missing.push(tool);
  }
  if (missing.length === 0) return;

  console.warn(
    `[arkeon] Worker toolchain incomplete — missing: ${missing.join(", ")}`,
  );
  console.warn(
    `         Workers can still be created, but their shell commands may fail.`,
  );
  console.warn(
    `         Install with:`,
  );
  if (platform() === "darwin") {
    console.warn(`           brew install ${missing.join(" ")}`);
  } else if (platform() === "linux") {
    console.warn(`           sudo apt-get install ${missing.join(" ")}`);
  }
}

// =====================================================================
// Pidfile management
// =====================================================================

export function writePidfile(pid: number): void {
  writeFileSync(pidfile(), String(pid), "utf-8");
}

export function readPidfile(): number | null {
  const path = pidfile();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function removePidfile(): void {
  const path = pidfile();
  if (existsSync(path)) unlinkSync(path);
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't send anything, just checks existence + permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means it exists but we can't signal it — still "alive"
    return code === "EPERM";
  }
}

// =====================================================================
// Sha256 helper for binary checksums (future use)
// =====================================================================

export function sha256File(path: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

// =====================================================================
// URL-safe fmt helper to build Postgres URLs with percent-encoded pw.
// (postgres.js handles % encoding fine if we do it ourselves.)
// =====================================================================

export function fmtPgUrl(
  user: string,
  password: string,
  host: string,
  port: number,
  db: string,
): string {
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

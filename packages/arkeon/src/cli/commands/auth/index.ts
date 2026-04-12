// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "commander";
import { readFileSync } from "node:fs";

import { signMessage, generateKeypair, solveChallenge } from "../../lib/auth.js";
import { credentials } from "../../lib/credentials.js";
import { apiRequest } from "../../lib/http.js";
import { output } from "../../lib/output.js";

type RegisterOptions = {
  name?: string;
  metadata?: string;
  metadataFile?: string;
  force?: boolean;
};

type ChallengeResponse = {
  nonce: string;
  difficulty: number;
  expires_at: string;
};

type RegisterResponse = {
  entity: {
    id: string;
  };
  api_key: string;
  key_prefix: string;
};

type RecoverResponse = {
  entity_id: string;
  api_key: string;
  key_prefix: string;
};

function parseOptionalJson(json?: string, filePath?: string): Record<string, unknown> | undefined {
  if (!json && !filePath) {
    return undefined;
  }

  const raw = typeof json === "string" ? json : readFileSync(filePath as string, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Authentication commands");

  auth
    .command("register")
    .description("Register a new agent and store credentials locally")
    .option("--name <name>", "Optional agent display name")
    .option("--metadata <json>", "Metadata JSON")
    .option("--metadata-file <path>", "Read metadata JSON from file")
    .option("--force", "Overwrite existing stored credentials")
    .action(async (options: RegisterOptions) => {
      try {
        const existing = credentials.get();
        if (existing && !options.force) {
          throw new Error("Stored credentials already exist. Re-run with --force to replace them.");
        }

        const metadata = parseOptionalJson(options.metadata, options.metadataFile);

        output.progress("Generating Ed25519 keypair...");
        const keypair = await generateKeypair();

        output.progress("Requesting proof-of-work challenge...");
        const challenge = await apiRequest<ChallengeResponse>("/auth/challenge", {
          method: "POST",
          body: JSON.stringify({ public_key: keypair.publicKey }),
        });

        output.progress(`Solving proof-of-work challenge (difficulty ${challenge.difficulty})...`);
        const solution = await solveChallenge(
          challenge.nonce,
          keypair.publicKey,
          challenge.difficulty,
        );

        output.progress("Signing challenge nonce...");
        const signature = await signMessage(challenge.nonce, keypair.privateKey);

        output.progress("Registering agent...");
        const result = await apiRequest<RegisterResponse>("/auth/register", {
          method: "POST",
          body: JSON.stringify({
            public_key: keypair.publicKey,
            nonce: challenge.nonce,
            signature,
            solution,
            ...(options.name ? { name: options.name } : {}),
            ...(metadata ? { metadata } : {}),
          }),
        });

        credentials.save({
          apiKey: result.api_key,
          keyPrefix: result.key_prefix,
          entityId: result.entity.id,
          publicKey: keypair.publicKey,
          privateKey: keypair.privateKey,
        });

        output.result({
          operation: "auth.register",
          entity_id: result.entity.id,
          key_prefix: result.key_prefix,
          api_key: result.api_key,
          credentials_path: credentials.path(),
          public_key: keypair.publicKey,
        });
      } catch (error) {
        output.error(error, { operation: "auth.register" });
        process.exitCode = 1;
      }
    });

  auth
    .command("recover")
    .description("Recover API access using the locally stored identity key")
    .action(async () => {
      try {
        const identity = credentials.getIdentity();
        if (!identity?.publicKey || !identity.privateKey) {
          throw new Error("No stored identity key found. Registration is required before recovery.");
        }

        const timestamp = new Date().toISOString();
        const payload = JSON.stringify({ action: "recover", timestamp });
        const signature = await signMessage(payload, identity.privateKey);

        output.progress("Recovering API access...");
        const result = await apiRequest<RecoverResponse>("/auth/recover", {
          method: "POST",
          body: JSON.stringify({
            public_key: identity.publicKey,
            signature,
            timestamp,
          }),
        });

        credentials.save({
          apiKey: result.api_key,
          keyPrefix: result.key_prefix,
          entityId: result.entity_id,
          publicKey: identity.publicKey,
          privateKey: identity.privateKey,
        });

        output.result({
          operation: "auth.recover",
          entity_id: result.entity_id,
          key_prefix: result.key_prefix,
          api_key: result.api_key,
          credentials_path: credentials.path(),
          public_key: identity.publicKey,
        });
      } catch (error) {
        output.error(error, { operation: "auth.recover" });
        process.exitCode = 1;
      }
    });

  auth
    .command("set-api-key")
    .description("Store an API key locally")
    .argument("<key>", "API key")
    .action((key: string) => {
      credentials.save({
        apiKey: key,
        keyPrefix: key.slice(0, 8),
      });
      output.result({
        operation: "auth.set-api-key",
        key_prefix: key.slice(0, 8),
        credentials_path: credentials.path(),
      });
    });

  auth
    .command("status")
    .alias("whoami")
    .description("Show stored authentication status")
    .action(() => {
      const stored = credentials.get();
      const apiKey = credentials.getApiKey();
      if (!apiKey && !stored?.privateKey) {
        output.result({
          operation: "auth.status",
          authenticated: false,
          credentials_path: credentials.path(),
        });
        return;
      }

      output.result({
        operation: "auth.status",
        authenticated: Boolean(apiKey),
        has_identity_key: Boolean(stored?.privateKey),
        key_prefix: apiKey ? `${apiKey.slice(0, 8)}...` : null,
        entity_id: stored?.entityId ?? null,
        public_key_prefix: stored?.publicKey ? `${stored.publicKey.slice(0, 16)}...` : null,
        credentials_path: credentials.path(),
      });
    });

  auth
    .command("logout")
    .description("Clear stored credentials")
    .action(() => {
      credentials.clear();
      output.result({
        operation: "auth.logout",
        cleared: true,
        credentials_path: credentials.path(),
      });
    });
}

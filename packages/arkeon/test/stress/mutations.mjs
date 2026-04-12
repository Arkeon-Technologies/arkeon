// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID, webcrypto } from "node:crypto";

const baseUrl = process.env.E2E_BASE_URL ?? "https://arke-api.nick-chimicles-professional.workers.dev";
const total = Number.parseInt(process.env.STRESS_TOTAL ?? "30", 10);
const concurrency = Number.parseInt(process.env.STRESS_CONCURRENCY ?? "5", 10);

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function countLeadingZeroBits(buffer) {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((byte & (1 << bit)) === 0) count += 1;
      else return count;
    }
  }
  return count;
}

function solvePow(nonce, publicKey, difficulty) {
  let counter = 0;
  while (true) {
    const digest = createHash("sha256").update(`${nonce}${publicKey}${counter}`).digest();
    if (countLeadingZeroBits(digest) >= difficulty) return counter;
    counter += 1;
  }
}

async function registerAgent(name) {
  const keyPair = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKey = bytesToBase64(rawPublicKey);

  let response = await fetch(`${baseUrl}/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public_key: publicKey }),
  });
  const challenge = await response.json();

  const signature = new Uint8Array(
    await webcrypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(challenge.nonce)),
  );

  response = await fetch(`${baseUrl}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      public_key: publicKey,
      nonce: challenge.nonce,
      solution: solvePow(challenge.nonce, publicKey, challenge.difficulty),
      signature: bytesToBase64(signature),
      name,
    }),
  });
  const body = await response.json();
  return body.api_key;
}

async function jsonRequest(path, apiKey, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `ApiKey ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function run() {
  const apiKey = await registerAgent(`stress-owner-${randomUUID().slice(0, 8)}`);
  const commons = await jsonRequest("/commons", apiKey, { properties: { label: `stress-commons-${randomUUID().slice(0, 8)}` } });
  const commonsId = commons.commons.id;
  let completed = 0;
  let next = 0;
  const startedAt = Date.now();

  async function worker() {
    while (next < total) {
      const current = next;
      next += 1;
      await jsonRequest("/entities", apiKey, {
        type: "note",
        commons_id: commonsId,
        properties: {
          label: `stress-entity-${current}-${randomUUID().slice(0, 6)}`,
          description: "stress mutation run",
        },
      });
      completed += 1;
      if (completed % 5 === 0 || completed === total) {
        console.log(`completed ${completed}/${total}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  console.log(JSON.stringify({ total, concurrency, duration_ms: Date.now() - startedAt, commons_id: commonsId }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

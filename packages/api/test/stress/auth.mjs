import { createHash, randomUUID, webcrypto } from "node:crypto";

const baseUrl = process.env.E2E_BASE_URL ?? "https://arke-api.nick-chimicles-professional.workers.dev";
const total = Number.parseInt(process.env.STRESS_TOTAL ?? "25", 10);
const concurrency = Number.parseInt(process.env.STRESS_CONCURRENCY ?? "5", 10);
const maxRetries = Number.parseInt(process.env.STRESS_RETRIES ?? "4", 10);
const baseBackoffMs = Number.parseInt(process.env.STRESS_BACKOFF_MS ?? "400", 10);
const connectionClose = process.env.STRESS_CONNECTION_CLOSE === "1";
let retryCount = 0;

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

async function registerOne(index) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const keyPair = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
      const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
      const publicKey = bytesToBase64(rawPublicKey);

      let response = await fetch(`${baseUrl}/auth/challenge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(connectionClose ? { connection: "close" } : {}),
        },
        body: JSON.stringify({ public_key: publicKey }),
      });
      const challenge = await response.json();
      if (response.status !== 200) throw new Error(`challenge failed for ${index}: ${response.status}`);

      const signature = new Uint8Array(
        await webcrypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(challenge.nonce)),
      );

      response = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(connectionClose ? { connection: "close" } : {}),
        },
        body: JSON.stringify({
          public_key: publicKey,
          nonce: challenge.nonce,
          solution: solvePow(challenge.nonce, publicKey, challenge.difficulty),
          signature: bytesToBase64(signature),
          name: `stress-auth-${randomUUID().slice(0, 8)}`,
        }),
      });
      if (response.status !== 201) {
        throw new Error(`register failed for ${index}: ${response.status} ${await response.text()}`);
      }
      return;
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      if (isLastAttempt) {
        throw error;
      }
      retryCount += 1;
      const delayMs = baseBackoffMs * 2 ** attempt;
      console.warn(`retrying auth registration ${index} after error on attempt ${attempt + 1}: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function run() {
  const startedAt = Date.now();
  let next = 0;
  let completed = 0;

  async function worker() {
    while (next < total) {
      const current = next;
      next += 1;
      await registerOne(current);
      completed += 1;
      if (completed % 5 === 0 || completed === total) {
        console.log(`completed ${completed}/${total}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({ total, concurrency, duration_ms: durationMs, retries: retryCount, connection_close: connectionClose }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

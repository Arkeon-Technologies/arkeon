import { createHash, randomUUID, webcrypto } from "node:crypto";
import { expect } from "vitest";

export const baseUrl =
  process.env.E2E_BASE_URL ??
  "https://arke-api.nick-chimicles-professional.workers.dev";

export const runPresignedE2E = process.env.E2E_PRESIGNED === "1";

type RequestOptions = {
  method?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
};

export type RegisteredAgent = {
  publicKey: string;
  privateKey: CryptoKey;
  apiKey: string;
  entityId: string;
  keyId?: string;
};

export function uniqueName(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

export function base64FromBytes(bytes: Uint8Array) {
  return bytesToBase64(bytes);
}

function countLeadingZeroBits(buffer: Uint8Array) {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((byte & (1 << bit)) === 0) {
        count += 1;
      } else {
        return count;
      }
    }
  }
  return count;
}

export function solvePow(nonce: string, publicKey: string, difficulty: number) {
  let counter = 0;
  while (true) {
    const digest = createHash("sha256")
      .update(`${nonce}${publicKey}${counter}`)
      .digest();
    if (countLeadingZeroBits(digest) >= difficulty) {
      return counter;
    }
    counter += 1;
  }
}

export async function apiRequest(path: string, options: RequestOptions = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.apiKey) {
    headers.set("authorization", `ApiKey ${options.apiKey}`);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ?? null,
  });

  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (response.status !== 204 && contentType.includes("application/json")) {
    body = await response.json();
  } else if (response.status !== 204) {
    body = await response.text();
  }

  return { response, body };
}

export async function jsonRequest(path: string, options: RequestOptions & { json?: unknown } = {}) {
  const headers = {
    ...(options.headers ?? {}),
    ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
  };
  return apiRequest(path, {
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body ?? null,
  });
}

export async function getJson(path: string) {
  const { response, body } = await apiRequest(path);
  return { response, body: body as Record<string, any> };
}

export async function registerAgent(name = uniqueName("agent")): Promise<RegisteredAgent> {
  const keyPair = await generateSigningKeyPair();
  const publicKey = keyPair.publicKey;

  const { challengeBody } = await requestChallenge(publicKey);
  const solution = solvePow(challengeBody.nonce, publicKey, challengeBody.difficulty);
  const signature = await signText(keyPair.privateKey, challengeBody.nonce);

  const { response: registerResponse, body: registerBodyRaw } = await jsonRequest("/auth/register", {
    method: "POST",
    json: {
      public_key: publicKey,
      nonce: challengeBody.nonce,
      solution,
      signature,
      name,
    },
  });
  const registerBody = registerBodyRaw as { api_key: string; entity: { id: string } };
  expect(registerResponse.status).toBe(201);

  return {
    publicKey,
    privateKey: keyPair.privateKey,
    apiKey: registerBody.api_key,
    entityId: registerBody.entity.id,
  };
}

export async function generateSigningKeyPair() {
  const keyPair = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const rawPublicKey = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
  return {
    publicKey: bytesToBase64(rawPublicKey),
    privateKey: keyPair.privateKey,
    publicCryptoKey: keyPair.publicKey,
  };
}

export async function requestChallenge(publicKey: string) {
  const { response: challengeResponse, body: challengeBodyRaw } = await jsonRequest("/auth/challenge", {
    method: "POST",
    json: { public_key: publicKey },
  });
  const challengeBody = challengeBodyRaw as { nonce: string; difficulty: number };
  expect(challengeResponse.status).toBe(200);
  return { response: challengeResponse, challengeBody };
}

export async function signText(privateKey: CryptoKey, text: string) {
  const signatureBytes = new Uint8Array(
    await webcrypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(text),
    ),
  );
  return bytesToBase64(signatureBytes);
}

export async function recoverAgent(agent: RegisteredAgent) {
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ action: "recover", timestamp });
  const signature = await signText(agent.privateKey, payload);

  const { response, body } = await jsonRequest("/auth/recover", {
    method: "POST",
    json: {
      public_key: agent.publicKey,
      timestamp,
      signature,
    },
  });

  return {
    response,
    body: body as { api_key: string; entity_id: string; key_prefix: string },
  };
}

export async function createCommons(apiKey: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { response, body } = await jsonRequest("/commons", {
    method: "POST",
    apiKey,
    json: { properties, ...extra },
  });
  expect(response.status).toBe(201);
  return (body as { commons: Record<string, any> }).commons;
}

export async function createEntity(
  apiKey: string,
  commonsId: string,
  type: string,
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const { response, body } = await jsonRequest("/entities", {
    method: "POST",
    apiKey,
    json: { type, commons_id: commonsId, properties, ...extra },
  });
  expect(response.status).toBe(201);
  return (body as { entity: Record<string, any> }).entity;
}

export async function createGrant(apiKey: string, entityId: string, actorId: string, accessType: string) {
  const { response, body } = await jsonRequest(`/entities/${entityId}/access/grants`, {
    method: "POST",
    apiKey,
    json: { actor_id: actorId, access_type: accessType },
  });
  expect(response.status).toBe(201);
  return body as { grant: Record<string, any> };
}

export async function createComment(apiKey: string, entityId: string, body: string, parentId?: string) {
  const { response, body: responseBody } = await jsonRequest(`/entities/${entityId}/comments`, {
    method: "POST",
    apiKey,
    json: { body, ...(parentId ? { parent_id: parentId } : {}) },
  });
  expect(response.status).toBe(201);
  return responseBody as Record<string, any>;
}

export async function createRelationship(
  apiKey: string,
  entityId: string,
  predicate: string,
  targetId: string,
  properties: Record<string, unknown> = {},
) {
  const { response, body } = await jsonRequest(`/entities/${entityId}/relationships`, {
    method: "POST",
    apiKey,
    json: { predicate, target_id: targetId, properties },
  });
  expect(response.status).toBe(201);
  return body as { relationship_entity: Record<string, any>; edge: Record<string, any> };
}

export async function uploadDirectContent(apiKey: string, entityId: string, key: string, ver: number, content: string, filename?: string) {
  const { response, body } = await apiRequest(
    `/entities/${entityId}/content?key=${encodeURIComponent(key)}&ver=${ver}${filename ? `&filename=${encodeURIComponent(filename)}` : ""}`,
    {
      method: "POST",
      apiKey,
      headers: { "content-type": "text/plain" },
      body: content,
    },
  );
  expect(response.status).toBe(200);
  return body as { cid: string; size: number; key: string; ver: number };
}

export async function waitForNotifications(apiKey: string, minCount = 1, since?: string, attempts = 10, delayMs = 300) {
  const sinceParam = since ? `?since=${encodeURIComponent(since)}` : "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { response, body } = await apiRequest(`/auth/me/inbox/count${sinceParam}`, { apiKey });
    if (response.status === 200 && (body as { count: number }).count >= minCount) {
      return body as { count: number };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return apiRequest(`/auth/me/inbox/count${sinceParam}`, { apiKey }).then(({ body }) => body as { count: number });
}

function encodeVarint(value: number) {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function encodeBase32Lower(bytes: Uint8Array) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }

  return output;
}

export async function computeCidFromText(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes));
  const version = Uint8Array.of(0x01);
  const codec = encodeVarint(0x55);
  const multihashCode = encodeVarint(0x12);
  const multihashLength = encodeVarint(digest.length);
  const cidBytes = new Uint8Array(
    version.length + codec.length + multihashCode.length + multihashLength.length + digest.length,
  );

  let offset = 0;
  cidBytes.set(version, offset);
  offset += version.length;
  cidBytes.set(codec, offset);
  offset += codec.length;
  cidBytes.set(multihashCode, offset);
  offset += multihashCode.length;
  cidBytes.set(multihashLength, offset);
  offset += multihashLength.length;
  cidBytes.set(digest, offset);

  return `b${encodeBase32Lower(cidBytes)}`;
}

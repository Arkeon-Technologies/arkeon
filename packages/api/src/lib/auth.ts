// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

const textEncoder = new TextEncoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  const bytes = new Uint8Array(digest);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseApiKeyHeader(headerValue: string | null | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const [scheme, token] = headerValue.split(/\s+/, 2);
  if (scheme !== "ApiKey" || !token) {
    return null;
  }

  return token;
}

export function extractApiKey(
  authorizationHeader: string | null | undefined,
  xApiKeyHeader: string | null | undefined,
): string | null {
  // Prefer X-API-Key (raw key value)
  if (xApiKeyHeader) {
    return xApiKeyHeader;
  }
  // Fall back to Authorization: ApiKey <key>
  return parseApiKeyHeader(authorizationHeader);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function createApiKey() {
  const key = `ak_${randomHex(32)}`;
  return {
    value: key,
    keyPrefix: key.slice(0, 8),
  };
}

export function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error("Invalid base64");
  }
}

export async function importEd25519PublicKey(publicKeyBase64: string) {
  const raw = decodeBase64(publicKeyBase64);
  if (raw.byteLength !== 32) {
    throw new Error("Invalid Ed25519 public key length");
  }

  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "Ed25519", false, ["verify"]);
}

export async function verifyEd25519Signature(
  publicKeyBase64: string,
  signatureBase64: string,
  message: string,
) {
  const key = await importEd25519PublicKey(publicKeyBase64);
  const signature = decodeBase64(signatureBase64);

  return crypto.subtle.verify(
    "Ed25519",
    key,
    toArrayBuffer(signature),
    toArrayBuffer(textEncoder.encode(message)),
  );
}

export function countLeadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
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

export async function verifyPowSolution(
  nonce: string,
  publicKey: string,
  solution: number,
  difficulty: number,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${nonce}${publicKey}${solution}`),
  );

  return countLeadingZeroBits(new Uint8Array(digest)) >= difficulty;
}

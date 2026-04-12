// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

export type KeyPair = {
  publicKey: string;
  privateKey: string;
};

type WebCryptoKeyPair = {
  publicKey: any;
  privateKey: any;
};

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function isCryptoKeyPair(value: unknown): value is WebCryptoKeyPair {
  return (
    !!value &&
    typeof value === "object" &&
    "publicKey" in value &&
    "privateKey" in value
  );
}

export async function generateKeypair(): Promise<KeyPair> {
  const generated = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  if (!isCryptoKeyPair(generated)) {
    throw new Error("Expected Ed25519 keypair generation to return a CryptoKeyPair.");
  }

  const publicKey = await crypto.subtle.exportKey("raw", generated.publicKey);
  const privateKey = await crypto.subtle.exportKey("pkcs8", generated.privateKey);

  return {
    publicKey: toBase64(publicKey),
    privateKey: toBase64(privateKey),
  };
}

export async function signMessage(message: string, privateKeyBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64(privateKeyBase64),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(message),
  );
  return toBase64(signature);
}

export async function solveChallenge(
  nonce: string,
  publicKey: string,
  difficulty: number,
): Promise<number> {
  const prefix = new TextEncoder().encode(`${nonce}${publicKey}`);

  for (let counter = 0; ; counter += 1) {
    const suffix = new TextEncoder().encode(String(counter));
    const input = new Uint8Array(prefix.length + suffix.length);
    input.set(prefix);
    input.set(suffix, prefix.length);

    const hashBuffer = await crypto.subtle.digest("SHA-256", input);
    const hashBytes = new Uint8Array(hashBuffer);
    if (countLeadingZeroBits(hashBytes) >= difficulty) {
      return counter;
    }
  }
}

function countLeadingZeroBits(bytes: Uint8Array): number {
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

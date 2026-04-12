// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

export const MAX_FILE_SIZE = 500 * 1024 * 1024;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Uint8Array.from(bytes);
}

function encodeBase32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export async function computeCidFromBytes(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digestBuffer = await crypto.subtle.digest("SHA-256", data);
  const digest = new Uint8Array(digestBuffer);

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

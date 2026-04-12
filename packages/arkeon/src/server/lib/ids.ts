// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, length: number): string {
  let encoded = "";
  let current = value;

  while (encoded.length < length) {
    encoded = CROCKFORD[current % 32] + encoded;
    current = Math.floor(current / 32);
  }

  return encoded;
}

function randomChars(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let result = "";

  for (let index = 0; index < length; index += 1) {
    result += CROCKFORD[bytes[index] % 32];
  }

  return result;
}

export function generateUlid(now = Date.now()): string {
  return `${encodeBase32(now, 10)}${randomChars(16)}`;
}

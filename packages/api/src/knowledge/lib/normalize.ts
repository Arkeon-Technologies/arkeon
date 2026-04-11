// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalize an entity label for comparison.
 * Strips common prefixes (titles), collapses whitespace, lowercases.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(
      /^(col\.|gen\.|adm\.|dr\.|mr\.|mrs\.|ms\.|prof\.|minister|ambassador|secretary)\s+/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

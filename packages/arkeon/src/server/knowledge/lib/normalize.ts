// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Normalize an entity label for comparison.
 * Strips diacritics (so "René" matches "Rene"), leading articles and
 * honorific prefixes, collapses whitespace, lowercases.
 */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(
      /^(the|a|an)\s+/i,
      "",
    )
    .replace(
      /^(col\.|gen\.|adm\.|dr\.|mr\.|mrs\.|ms\.|prof\.|minister|ambassador|secretary)\s+/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

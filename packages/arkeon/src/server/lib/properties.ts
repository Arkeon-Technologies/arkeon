// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deep-merge two plain objects. Recurses into nested objects; for other types:
 * - Strings: keep longest
 * - Arrays: union by JSON equality
 * - Other: keep existing (first non-null wins)
 */
export function deepMergeObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const existing = result[key];
    if (existing === undefined || existing === null) {
      result[key] = value;
    } else if (typeof existing === "string" && typeof value === "string") {
      if (value.length > existing.length) result[key] = value;
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      const seen = new Set(existing.map((v) => JSON.stringify(v)));
      const merged = [...existing];
      for (const item of value) {
        const k = JSON.stringify(item);
        if (!seen.has(k)) {
          merged.push(item);
          seen.add(k);
        }
      }
      result[key] = merged;
    } else if (
      typeof existing === "object" && existing !== null && !Array.isArray(existing) &&
      typeof value === "object" && value !== null && !Array.isArray(value)
    ) {
      result[key] = deepMergeObjects(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    }
    // else: keep existing (first non-null wins for other types)
  }
  return result;
}

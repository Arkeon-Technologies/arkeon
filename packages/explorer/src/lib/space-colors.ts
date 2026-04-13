// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

const NO_SPACE_COLOR = '#52525b'

// Golden angle in degrees for deterministic hue rotation
const GOLDEN_ANGLE = 137.508
// Offset to avoid collision with type-colors (which starts near 0)
const HUE_OFFSET = 30

export function getSpaceColor(spaceId: string | undefined): string {
  if (!spaceId) return NO_SPACE_COLOR

  let hash = 0
  for (let i = 0; i < spaceId.length; i++) {
    hash = spaceId.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = (Math.abs(hash) * GOLDEN_ANGLE + HUE_OFFSET) % 360
  return `hsl(${hue}, 60%, 55%)`
}

/**
 * Get the primary space color for an entity based on its space_ids.
 * Uses the first space_id if multiple exist, falls back to neutral gray.
 */
export function getEntitySpaceColor(spaceIds?: string[]): string {
  return getSpaceColor(spaceIds?.[0])
}

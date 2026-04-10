const TYPE_COLOR_MAP: Record<string, string> = {
  user: '#6366f1',
  collection: '#22c55e',
  file: '#f59e0b',
  folder: '#3b82f6',
  concept: '#8b5cf6',
  document: '#06b6d4',
  person: '#ec4899',
  organization: '#14b8a6',
  event: '#f97316',
  place: '#84cc16',
}

// Golden angle in degrees (~137.5) for deterministic hue rotation
const GOLDEN_ANGLE = 137.508

export function getTypeColor(type: string): string {
  const known = TYPE_COLOR_MAP[type.toLowerCase()]
  if (known) return known

  // Deterministic hue from string hash using golden angle rotation
  let hash = 0
  for (let i = 0; i < type.length; i++) {
    hash = type.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = (Math.abs(hash) * GOLDEN_ANGLE) % 360
  return `hsl(${hue}, 65%, 55%)`
}

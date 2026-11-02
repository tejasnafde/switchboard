/** How much of a usage limit is left, and how loudly to say so. */

export type LeftTone = 'neutral' | 'warning' | 'error'

/** 100 minus the used percent, clamped to 0..100 and rounded; null when the used percent is unknown. */
export function leftPercent(usedPercent: number | null): number | null {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null
  return Math.round(Math.min(100, Math.max(0, 100 - usedPercent)))
}

/** Error at 10 % left or less, warning at 20 % or less. */
export function leftTone(left: number | null): LeftTone {
  if (left === null) return 'neutral'
  if (left <= 10) return 'error'
  if (left <= 20) return 'warning'
  return 'neutral'
}

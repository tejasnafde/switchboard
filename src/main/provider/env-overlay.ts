/**
 * Apply a provider-instance env overlay to a target env map. Empty-string
 * values are skipped so partially-filled instance configs don't blank out
 * shell-exported defaults.
 */
export function applyEnvOverlay(
  target: Record<string, string>,
  overlay: Record<string, string> | undefined,
): void {
  if (!overlay) return
  for (const [k, v] of Object.entries(overlay)) {
    if (v.length > 0) target[k] = v
  }
}

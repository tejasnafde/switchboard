/**
 * In-band marker for "user switched provider instance mid-conversation".
 *
 * Persisted as a system-role ChatMessage with content of the form:
 *   `${ROTATION_MARKER_PREFIX} <fromName> → <toName>`
 *
 * MessageBubble detects the prefix and renders a compact pill instead of
 * a generic system message bubble. Storing the human-readable form (not
 * a structured object) keeps it compatible with the existing message
 * persistence layer and exporters without a schema change.
 */
export const ROTATION_MARKER_PREFIX = '[[sb:instance-rotated]]'

export interface RotationMarker {
  fromName: string
  toName: string
}

export function parseRotationMarker(content: string): RotationMarker | null {
  if (!content.startsWith(ROTATION_MARKER_PREFIX)) return null
  const rest = content.slice(ROTATION_MARKER_PREFIX.length).trim()
  // Tolerate either '→' (default) or '->' for hand-edited cases.
  const arrow = rest.includes('→') ? '→' : (rest.includes('->') ? '->' : null)
  if (!arrow) return null
  const [fromName, toName] = rest.split(arrow).map((s) => s.trim())
  if (!fromName || !toName) return null
  return { fromName, toName }
}

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

/**
 * Same wire shape for "user switched agent kind mid-conversation"
 * (Claude ↔ Codex ↔ OpenCode). Unlike an instance rotation, an agent
 * swap starts the next turn with zero context, so the pill warns too.
 */
export const AGENT_SWITCH_MARKER_PREFIX = '[[sb:agent-switched]]'

export interface RotationMarker {
  kind: 'instance' | 'agent'
  fromName: string
  toName: string
}

export function parseRotationMarker(content: string): RotationMarker | null {
  const kind = content.startsWith(ROTATION_MARKER_PREFIX)
    ? ('instance' as const)
    : content.startsWith(AGENT_SWITCH_MARKER_PREFIX) ? ('agent' as const) : null
  if (!kind) return null
  const prefix = kind === 'instance' ? ROTATION_MARKER_PREFIX : AGENT_SWITCH_MARKER_PREFIX
  const rest = content.slice(prefix.length).trim()
  // Tolerate either '→' (default) or '->' for hand-edited cases.
  const arrow = rest.includes('→') ? '→' : (rest.includes('->') ? '->' : null)
  if (!arrow) return null
  const [fromName, toName] = rest.split(arrow).map((s) => s.trim())
  if (!fromName || !toName) return null
  return { kind, fromName, toName }
}

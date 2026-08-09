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

/**
 * Marker written when a turn was sent with a cross-provider context
 * handoff preamble prefixed (agent switch over history, or the first
 * turn on a degraded Codex / OpenCode fork). Distinct from the agent
 * switch marker above: that one records the switch, this one records
 * that the transcript was actually replayed to the new agent.
 */
export const CONTEXT_HANDOFF_MARKER_PREFIX = '[[sb:context-handoff]]'

export interface RotationMarker {
  kind: 'instance' | 'agent' | 'handoff'
  fromName: string
  toName: string
}

const MARKER_PREFIXES: Record<RotationMarker['kind'], string> = {
  instance: ROTATION_MARKER_PREFIX,
  agent: AGENT_SWITCH_MARKER_PREFIX,
  handoff: CONTEXT_HANDOFF_MARKER_PREFIX,
}

export function parseRotationMarker(content: string): RotationMarker | null {
  const kind = (Object.keys(MARKER_PREFIXES) as RotationMarker['kind'][])
    .find((k) => content.startsWith(MARKER_PREFIXES[k])) ?? null
  if (!kind) return null
  const prefix = MARKER_PREFIXES[kind]
  const rest = content.slice(prefix.length).trim()
  // Tolerate either '→' (default) or '->' for hand-edited cases.
  const arrow = rest.includes('→') ? '→' : (rest.includes('->') ? '->' : null)
  if (!arrow) return null
  const [fromName, toName] = rest.split(arrow).map((s) => s.trim())
  if (!fromName || !toName) return null
  return { kind, fromName, toName }
}

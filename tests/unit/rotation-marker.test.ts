import { describe, it, expect } from 'vitest'
import { parseRotationMarker, ROTATION_MARKER_PREFIX, AGENT_SWITCH_MARKER_PREFIX } from '../../src/renderer/components/chat/rotationMarker'

describe('parseRotationMarker', () => {
  it('parses the canonical "from → to" form', () => {
    const out = parseRotationMarker(`${ROTATION_MARKER_PREFIX} Default → Tech Team`)
    expect(out).toEqual({ kind: 'instance', fromName: 'Default', toName: 'Tech Team' })
  })

  it('parses an agent-switch marker with kind "agent"', () => {
    const out = parseRotationMarker(`${AGENT_SWITCH_MARKER_PREFIX} Claude Code → Codex`)
    expect(out).toEqual({ kind: 'agent', fromName: 'Claude Code', toName: 'Codex' })
  })

  it('tolerates ASCII arrow', () => {
    const out = parseRotationMarker(`${ROTATION_MARKER_PREFIX} A -> B`)
    expect(out).toEqual({ kind: 'instance', fromName: 'A', toName: 'B' })
  })

  it('returns null for non-marker content', () => {
    expect(parseRotationMarker('hello world')).toBeNull()
    expect(parseRotationMarker('Error: something broke')).toBeNull()
  })

  it('returns null for malformed marker (no arrow)', () => {
    expect(parseRotationMarker(`${ROTATION_MARKER_PREFIX} just one name`)).toBeNull()
    expect(parseRotationMarker(`${AGENT_SWITCH_MARKER_PREFIX} just one name`)).toBeNull()
  })

  it('returns null when either side is empty', () => {
    expect(parseRotationMarker(`${ROTATION_MARKER_PREFIX}  → B`)).toBeNull()
    expect(parseRotationMarker(`${ROTATION_MARKER_PREFIX} A → `)).toBeNull()
  })
})

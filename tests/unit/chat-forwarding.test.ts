import { describe, expect, it } from 'vitest'
import { buildForwardedContext, forwardingTargets } from '../../src/renderer/services/chatForwarding'

const sessions = [
  { id: 'left', title: 'Architecture', type: 'claude-code' },
  { id: 'right', title: 'Implementation', type: 'codex' },
  { id: 'third', title: 'Review', type: 'opencode' },
]

describe('source-aware chat forwarding', () => {
  it('offers the other displayed chat first and never includes the source', () => {
    expect(forwardingTargets(sessions, 'right', ['left', 'right']).map((target) => target.id)).toEqual([
      'left',
      'third',
    ])
  })

  it('uses the actual source title and provider in forwarded provenance', () => {
    expect(buildForwardedContext('first line\nsecond line', {
      title: 'Implementation',
      provider: 'Codex',
    })).toBe('[Forwarded from Codex · "Implementation"]\n> first line\n> second line\n')
  })

  it('caps forwarded context without forwarding to itself implicitly', () => {
    const content = Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n')
    const forwarded = buildForwardedContext(content, { title: 'Review', provider: 'OpenCode' })
    expect(forwarded).toContain('> line 39')
    expect(forwarded).not.toContain('> line 40')
  })
})

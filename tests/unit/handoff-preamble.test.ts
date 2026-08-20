/**
 * Pure core of the cross-provider context handoff: the transcript
 * preamble builder plus the switch decision helpers. The wiring
 * (ChatPanel injection, fork pending flag) is covered separately in
 * fork-handoff-pending.test.ts and conversation-rotation-fallback.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  buildHandoffPreamble,
  stripHandoffPreamble,
  shouldInjectHandoff,
  nextPendingHandoffFrom,
  HANDOFF_PREAMBLE_HEADER,
  HANDOFF_PREAMBLE_FOOTER,
} from '../../src/shared/handoff'

const user = (content: string, images?: unknown[]) => ({ role: 'user', content, images })
const assistant = (content: string) => ({ role: 'assistant', content })

describe('buildHandoffPreamble', () => {
  it('renders user and assistant turns in order between header and footer', () => {
    const out = buildHandoffPreamble([user('hello'), assistant('hi there'), user('follow up')])
    expect(out).toBe(
      `${HANDOFF_PREAMBLE_HEADER}\n` +
      'user: hello\n' +
      'assistant: hi there\n' +
      'user: follow up\n\n' +
      HANDOFF_PREAMBLE_FOOTER,
    )
  })

  it('skips system markers, denials and other non user/assistant roles', () => {
    const out = buildHandoffPreamble([
      { role: 'system', content: '[[sb:agent-switched]] Claude Code → Codex' },
      user('real question'),
      { role: 'system', content: 'Error: something broke' },
      assistant('real answer'),
    ])
    expect(out).not.toContain('[[sb:')
    expect(out).not.toContain('Error:')
    expect(out).toContain('user: real question')
    expect(out).toContain('assistant: real answer')
  })

  it('skips empty and whitespace-only partial turns', () => {
    const out = buildHandoffPreamble([user('kept'), assistant(''), assistant('   \n  ')])
    expect(out).toContain('user: kept')
    expect(out).not.toContain('assistant:')
  })

  it('replaces images with a placeholder instead of serializing them', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANS'
    const out = buildHandoffPreamble([user('see screenshot', [{ url: dataUrl }, { url: dataUrl }])])
    expect(out).toContain('user: see screenshot\n[image omitted]\n[image omitted]')
    expect(out).not.toContain('base64')
  })

  it('keeps an image-only turn as a placeholder line', () => {
    const out = buildHandoffPreamble([user('', [{ url: 'data:image/png;base64,xyz' }])])
    expect(out).toContain('user: [image omitted]')
  })

  it('returns null for an empty history', () => {
    expect(buildHandoffPreamble([])).toBeNull()
  })

  it('returns null when nothing is replayable', () => {
    expect(buildHandoffPreamble([{ role: 'system', content: 'notice' }, assistant('')])).toBeNull()
  })

  it('handles a single-message history', () => {
    const out = buildHandoffPreamble([user('only one')])
    expect(out).toBe(`${HANDOFF_PREAMBLE_HEADER}\nuser: only one\n\n${HANDOFF_PREAMBLE_FOOTER}`)
  })

  it('drops oldest turns first when over the cap and prepends the truncation notice', () => {
    const msgs = [
      user('oldest '.padEnd(200, 'a')),
      assistant('middle '.padEnd(200, 'b')),
      user('newest '.padEnd(200, 'c')),
    ]
    const out = buildHandoffPreamble(msgs, { maxChars: 580 })!
    expect(out.length).toBeLessThanOrEqual(580)
    expect(out.startsWith('(Earlier conversation truncated: 1 older turn omitted.)\n')).toBe(true)
    expect(out).not.toContain('oldest')
    expect(out).toContain('middle')
    expect(out).toContain('newest')
    // Notice comes before the header, header before the turns.
    expect(out.indexOf(HANDOFF_PREAMBLE_HEADER)).toBeGreaterThan(0)
    expect(out.indexOf('assistant: middle')).toBeGreaterThan(out.indexOf(HANDOFF_PREAMBLE_HEADER))
  })

  it('pluralizes the truncation notice', () => {
    const msgs = [
      user('one '.padEnd(300, 'a')),
      user('two '.padEnd(300, 'b')),
      user('three '.padEnd(300, 'c')),
    ]
    const out = buildHandoffPreamble(msgs, { maxChars: 500 })!
    expect(out).toContain('2 older turns omitted.')
  })

  it('caps even a single oversized turn', () => {
    const out = buildHandoffPreamble([user('x'.repeat(5000))], { maxChars: 600 })!
    expect(out.length).toBeLessThanOrEqual(600)
    expect(out.endsWith(HANDOFF_PREAMBLE_FOOTER)).toBe(true)
  })

  it('is deterministic for the same input', () => {
    const msgs = [user('a'), assistant('b')]
    expect(buildHandoffPreamble(msgs)).toBe(buildHandoffPreamble(msgs))
  })

  it('does not nest a prior injected preamble on a second handoff', () => {
    const firstWire = `${buildHandoffPreamble([user('original question')])}\n\nnext question`
    const out = buildHandoffPreamble([user('original question'), user(firstWire)])!
    expect(out).toContain('user: next question')
    // Exactly one header: the outer preamble's own.
    expect(out.split(HANDOFF_PREAMBLE_HEADER)).toHaveLength(2)
  })
})

describe('stripHandoffPreamble', () => {
  it('returns the trailing user text of an injected wire message', () => {
    const wire = `${buildHandoffPreamble([user('hi'), assistant('yo')])}\n\nactual message`
    expect(stripHandoffPreamble(wire)).toBe('actual message')
  })

  it('strips a truncated preamble too', () => {
    const preamble = buildHandoffPreamble(
      [user('a'.repeat(400)), user('b'.repeat(400))],
      { maxChars: 500 },
    )!
    expect(preamble.startsWith('(Earlier conversation truncated:')).toBe(true)
    expect(stripHandoffPreamble(`${preamble}\n\ntail`)).toBe('tail')
  })

  it('uses the final footer when replayed history quotes the footer sentence', () => {
    const quoted = `Earlier we discussed: ${HANDOFF_PREAMBLE_FOOTER}`
    const wire = `${buildHandoffPreamble([user(quoted), assistant('noted')])}\n\nactual message`
    expect(stripHandoffPreamble(wire)).toBe('actual message')
  })

  it('is a no-op for ordinary messages', () => {
    expect(stripHandoffPreamble('plain message')).toBe('plain message')
    expect(stripHandoffPreamble('')).toBe('')
  })
})

describe('shouldInjectHandoff', () => {
  it('is true for a real switch over history not yet injected', () => {
    expect(shouldInjectHandoff('claude-code', 'codex', true, false)).toBe(true)
  })

  it('is false when the provider did not change', () => {
    expect(shouldInjectHandoff('codex', 'codex', true, false)).toBe(false)
  })

  it('is false without history', () => {
    expect(shouldInjectHandoff('claude-code', 'codex', false, false)).toBe(false)
  })

  it('is false when already injected', () => {
    expect(shouldInjectHandoff('claude-code', 'codex', true, true)).toBe(false)
  })

  it('is false when either provider is unknown', () => {
    expect(shouldInjectHandoff(null, 'codex', true, false)).toBe(false)
    expect(shouldInjectHandoff('codex', undefined, true, false)).toBe(false)
  })
})

describe('nextPendingHandoffFrom', () => {
  it('records the previous provider on a qualifying switch', () => {
    expect(nextPendingHandoffFrom(null, 'claude-code', 'codex', true)).toBe('claude-code')
  })

  it('keeps the original source across chained switches before any send', () => {
    expect(nextPendingHandoffFrom('claude-code', 'codex', 'opencode', true)).toBe('claude-code')
  })

  it('clears when the user switches back to the pending source', () => {
    expect(nextPendingHandoffFrom('claude-code', 'codex', 'claude-code', true)).toBeNull()
  })

  it('stays null for a switch over an empty chat', () => {
    expect(nextPendingHandoffFrom(null, 'claude-code', 'codex', false)).toBeNull()
  })

  it('stays null for a non-switch', () => {
    expect(nextPendingHandoffFrom(null, 'codex', 'codex', true)).toBeNull()
  })
})

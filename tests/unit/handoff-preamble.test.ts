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
  HANDOFF_DELTA_HEADER,
  handoffBudgetChars,
  handoffDeltaStart,
  DEFAULT_HANDOFF_MAX_CHARS,
  planTurnHandoff,
  answeredHistory,
  withHandoffPreamble,
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

  it('skips system markers but keeps error rows in compact form', () => {
    const out = buildHandoffPreamble([
      { role: 'system', content: '[[sb:agent-switched]] Claude Code → Codex' },
      user('real question'),
      { role: 'system', content: 'Error: something\n   broke' },
      assistant('real answer'),
    ])
    expect(out).not.toContain('[[sb:')
    expect(out).toContain('user: real question\nerror: something broke\nassistant: real answer')
  })

  it('includes tool calls with clipped input and output', () => {
    const out = buildHandoffPreamble([
      user('run the tests'),
      { role: 'assistant', content: 'running', toolCalls: [{ name: 'Bash', input: 'npm test', output: `FAIL ${'x'.repeat(1000)}` }] },
    ])!
    expect(out).toContain('assistant: running\n[tool Bash] npm test -> FAIL x')
    expect(out).not.toContain('x'.repeat(500))
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

  it('drops the oldest turns after the pinned first user message and prepends the notice', () => {
    const msgs = [
      user('first '.padEnd(200, 'a')),
      assistant('dropped '.padEnd(200, 'b')),
      assistant('middle '.padEnd(200, 'b')),
      user('newest '.padEnd(200, 'c')),
    ]
    const out = buildHandoffPreamble(msgs, { maxChars: 800 })!
    expect(out.length).toBeLessThanOrEqual(800)
    expect(out.startsWith('(Earlier conversation truncated: 1 older turn omitted.)\n')).toBe(true)
    expect(out).toContain('user: first')
    expect(out).not.toContain('dropped')
    expect(out).toContain('middle')
    expect(out).toContain('newest')
    // Notice comes before the header, header before the turns.
    expect(out.indexOf(HANDOFF_PREAMBLE_HEADER)).toBeGreaterThan(0)
    expect(out.indexOf('user: first')).toBeLessThan(out.indexOf('assistant: middle'))
  })

  it('drops the pinned message last, keeping the newest whole turn', () => {
    const msgs = [user('first '.padEnd(300, 'a')), assistant('newest '.padEnd(300, 'b'))]
    const out = buildHandoffPreamble(msgs, { maxChars: 500 })!
    expect(out).not.toContain('first')
    expect(out).toContain(`assistant: ${'newest '.padEnd(300, 'b')}`)
    expect(out).toContain('1 older turn omitted.')
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

  it('keeps the tail of an oversized newest turn, not its head', () => {
    const reply = `HEAD ${'x'.repeat(5000)} TAIL`
    const out = buildHandoffPreamble([user('q'), assistant(reply)], { maxChars: 600 })!
    expect(out.length).toBe(600)
    expect(out).toContain('assistant: [start cut] ')
    expect(out).toContain('TAIL\n\n')
    expect(out).not.toContain('HEAD')
  })

  it('replays only the delta after since, without pinning', () => {
    const msgs = [user('first'), assistant('a1'), user('second'), assistant('b1')]
    const out = buildHandoffPreamble(msgs, { since: 2 })!
    expect(out.startsWith(HANDOFF_DELTA_HEADER)).toBe(true)
    expect(out).not.toContain('first')
    expect(out).toContain('user: second\nassistant: b1')
    expect(stripHandoffPreamble(`${out}\n\nnext`)).toBe('next')
  })

  it('returns null for an empty delta', () => {
    expect(buildHandoffPreamble([user('first'), assistant('a1')], { since: 2 })).toBeNull()
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

describe('handoffDeltaStart', () => {
  const marker = (from: string, to: string) => ({ role: 'system', content: `[[sb:agent-switched]] ${from} → ${to}` })

  it('starts after the newest switch away from the target', () => {
    const msgs = [user('q1'), assistant('a1'), marker('Claude Code', 'Codex'), user('q2'), assistant('b2'), marker('Codex', 'Claude Code')]
    expect(handoffDeltaStart(msgs, 'Claude Code')).toBe(3)
  })

  it('is null when the target never took part', () => {
    expect(handoffDeltaStart([user('q'), marker('Claude Code', 'Codex')], 'OpenCode')).toBeNull()
  })

  it('uses the latest of several departures', () => {
    const msgs = [marker('Codex', 'OpenCode'), user('x'), marker('OpenCode', 'Codex'), user('y'), marker('Codex', 'OpenCode')]
    expect(handoffDeltaStart(msgs, 'Codex')).toBe(5)
  })
})

describe('handoffBudgetChars', () => {
  it('falls back to the default cap when the window is unknown', () => {
    expect(handoffBudgetChars(undefined)).toBe(DEFAULT_HANDOFF_MAX_CHARS)
    expect(handoffBudgetChars(null)).toBe(DEFAULT_HANDOFF_MAX_CHARS)
  })

  it('uses a quarter of a small window', () => {
    expect(handoffBudgetChars(32_000)).toBe(8_000 * 3)
  })

  it('never exceeds the token ceiling for a large window', () => {
    expect(handoffBudgetChars(1_000_000)).toBe(32_000 * 3)
  })
})

describe('planTurnHandoff', () => {
  const marker = (from: string, to: string) => ({ role: 'system', content: `[[sb:agent-switched]] ${from} → ${to}` })
  // Claude answered q1, the chat moved to Codex, which answered q2, and back.
  const abA = [user('q1'), assistant('claude answer'), marker('Claude Code', 'Codex'), user('q2'), assistant('codex answer'), marker('Codex', 'Claude Code')]

  it('A to B to A sends A only the turns it has not seen', () => {
    const plan = planTurnHandoff({ messages: abA, pendingFrom: 'codex', target: 'claude-code', resumedNatively: true })
    expect(plan.preamble).toContain('user: q2\nassistant: codex answer')
    expect(plan.preamble).not.toContain('claude answer')
    expect(plan.preamble).not.toContain('q1')
    expect(plan.markerText).toBe('[[sb:context-handoff]] Codex → Claude Code')
  })

  it('sends the whole conversation when the returning agent did not resume natively', () => {
    const plan = planTurnHandoff({ messages: abA, pendingFrom: 'codex', target: 'claude-code', resumedNatively: false })
    expect(plan.preamble).toContain('claude answer')
    expect(plan.preamble).toContain('codex answer')
  })

  it('sends the whole conversation to an agent that never took part', () => {
    const plan = planTurnHandoff({ messages: abA, pendingFrom: 'codex', target: 'opencode', resumedNatively: true })
    expect(plan.preamble?.startsWith(HANDOFF_PREAMBLE_HEADER)).toBe(true)
    expect(plan.preamble).toContain('claude answer')
  })

  it('a profile restart replays everything with its own marker', () => {
    const plan = planTurnHandoff({ messages: abA, pendingFrom: 'claude-code', target: 'claude-code', resumedNatively: true })
    expect(plan.preamble).toContain('claude answer')
    expect(plan.markerText).toBe('[[sb:context-handoff]] Claude Code profile restarted with visible history')
  })
})

describe('answeredHistory and withHandoffPreamble', () => {
  it('leaves out the trailing user messages the agent has not answered', () => {
    const msgs = [user('q1'), assistant('a1'), user('q2'), { role: 'system', content: 'Error: x' }, user('q3')]
    expect(answeredHistory(msgs)).toEqual([user('q1'), assistant('a1')])
    expect(answeredHistory([user('only')])).toEqual([])
  })

  it('replaces a preamble the message already carried', () => {
    const delta = buildHandoffPreamble([user('a'), assistant('b')], { since: 1 })!
    const full = buildHandoffPreamble([user('a'), assistant('b')])!
    expect(withHandoffPreamble(`${delta}\n\ntyped`, full)).toBe(`${full}\n\ntyped`)
    expect(withHandoffPreamble('typed', full)).toBe(`${full}\n\ntyped`)
  })
})

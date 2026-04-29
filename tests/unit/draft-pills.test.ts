/**
 * Draft pills are the structured, removable chips that float above the
 * chat textarea (Cursor-style). Each pill carries a short *label* (what
 * the user sees on the chip — e.g. `cloudbuild.base.yaml (2-9)`) plus
 * the *content* that gets serialized into the message body when the user
 * hits Send. Plain typed text continues to live in the draft string.
 *
 * Behaviors locked down:
 *   1. addPill / removePill / clearPills mutate per-session state
 *   2. serializePillsForSend renders each pill back into wire format,
 *      preserving order and separating with blank lines
 *   3. consumePillsForSend (used by handleSend) pops + serializes in one
 *      atomic step so we don't double-send
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useDraftStore, serializePillsForSend, type DraftPill } from '../../src/renderer/stores/draft-store'

const pill = (over: Partial<DraftPill> = {}): DraftPill => ({
  id: over.id ?? Math.random().toString(36),
  kind: over.kind ?? 'file',
  label: over.label ?? 'src/foo.ts (1-5)',
  content: over.content ?? '@src/foo.ts:1-5\n```\nconst x = 1\n```\n',
})

beforeEach(() => {
  // Fresh state between tests.
  const store = useDraftStore.getState()
  for (const sid of Object.keys(store.pillsBySession ?? {})) {
    store.clearPills(sid)
  }
})

describe('draft pills store', () => {
  it('addPill appends to the per-session list', () => {
    const sid = 's1'
    useDraftStore.getState().addPill(sid, pill({ id: 'a', label: 'a.ts' }))
    useDraftStore.getState().addPill(sid, pill({ id: 'b', label: 'b.py' }))
    expect(useDraftStore.getState().pillsBySession[sid].map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('removePill drops by id and leaves others intact', () => {
    const sid = 's1'
    useDraftStore.getState().addPill(sid, pill({ id: 'a' }))
    useDraftStore.getState().addPill(sid, pill({ id: 'b' }))
    useDraftStore.getState().removePill(sid, 'a')
    expect(useDraftStore.getState().pillsBySession[sid].map((p) => p.id)).toEqual(['b'])
  })

  it('clearPills wipes the session list entirely', () => {
    const sid = 's1'
    useDraftStore.getState().addPill(sid, pill())
    useDraftStore.getState().addPill(sid, pill())
    useDraftStore.getState().clearPills(sid)
    expect(useDraftStore.getState().pillsBySession[sid] ?? []).toEqual([])
  })

  it('isolates pills per session', () => {
    useDraftStore.getState().addPill('s1', pill({ id: 'one' }))
    useDraftStore.getState().addPill('s2', pill({ id: 'two' }))
    expect(useDraftStore.getState().pillsBySession['s1'].map((p) => p.id)).toEqual(['one'])
    expect(useDraftStore.getState().pillsBySession['s2'].map((p) => p.id)).toEqual(['two'])
  })
})

describe('draft text persistence (regression lock)', () => {
  it('setDraft + getDraft round-trips a per-session string', () => {
    useDraftStore.getState().setDraft('s-text', 'hello world')
    expect(useDraftStore.getState().getDraft('s-text')).toBe('hello world')
  })

  it('setDraft with empty string clears the entry (no orphan keys)', () => {
    useDraftStore.getState().setDraft('s-text', 'x')
    useDraftStore.getState().setDraft('s-text', '')
    expect(useDraftStore.getState().drafts['s-text']).toBeUndefined()
  })

  it('clearDraft removes the entry without touching others', () => {
    useDraftStore.getState().setDraft('a', 'one')
    useDraftStore.getState().setDraft('b', 'two')
    useDraftStore.getState().clearDraft('a')
    expect(useDraftStore.getState().drafts['a']).toBeUndefined()
    expect(useDraftStore.getState().drafts['b']).toBe('two')
  })

  it('appendDraft separates with a blank line when the existing draft has content', () => {
    useDraftStore.getState().setDraft('s', 'first')
    useDraftStore.getState().appendDraft('s', 'second')
    expect(useDraftStore.getState().getDraft('s')).toBe('first\n\nsecond')
  })

  it('appendDraft on empty draft just sets the value (no leading blank line)', () => {
    useDraftStore.getState().clearDraft('s2')
    useDraftStore.getState().appendDraft('s2', 'hello')
    expect(useDraftStore.getState().getDraft('s2')).toBe('hello')
  })
})

describe('serializePillsForSend', () => {
  it('returns empty string when there are no pills', () => {
    expect(serializePillsForSend([])).toBe('')
  })

  it('joins pill contents with blank lines, preserving order', () => {
    const out = serializePillsForSend([
      pill({ id: 'a', content: 'PILL_A' }),
      pill({ id: 'b', content: 'PILL_B' }),
    ])
    // Should end with a trailing newline so user-typed text starts on a new line.
    expect(out.startsWith('PILL_A')).toBe(true)
    expect(out).toContain('PILL_B')
    expect(out.indexOf('PILL_A')).toBeLessThan(out.indexOf('PILL_B'))
  })
})

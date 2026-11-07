/**
 * The children list of the chat header's Hub chip: the counts and this
 * chat's own state, the updates waiting with Show now, Resume on a stopped
 * child, and no token figure for a child that reported none.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HubChildrenList, hubTokenText } from '../../src/renderer/components/hub/HubChildrenList'
import { hubChipDot } from '../../src/renderer/components/hub/child-dot'
import { HUB_HELD_UPDATES_HINT, type HubChatRef, type HubChatView, type HubChildView } from '../../src/shared/hub'

const ref = (id: string, title = `Chat ${id}`): HubChatRef => ({
  id,
  familyIds: [id],
  title,
  agentType: 'claude-code',
  projectPath: '/repo',
  updatedAt: 0,
})

const child = (id: string, extra: Partial<HubChildView> = {}): HubChildView => ({
  chat: ref(id, `Child ${id}`),
  liveId: null,
  phase: 'open',
  state: 'paused',
  limit: 'none',
  waitingForSlot: false,
  account: null,
  branch: null,
  lastWake: null,
  lastTurn: null,
  ...extra,
})

const view = (children: HubChildView[], extra: Partial<HubChatView> = {}): HubChatView => ({
  self: ref('p', 'Parent'),
  parent: null,
  children,
  state: null,
  ...extra,
})

const html = (v: HubChatView) => renderToStaticMarkup(createElement(HubChildrenList, { view: v, onDone: () => {} }))

describe('the children list', () => {
  it('leaves out a token figure it does not have, and keeps one it has', () => {
    expect(hubTokenText(null)).toBeNull()
    expect(hubTokenText(undefined)).toBeNull()
    expect(hubTokenText(0)).toBeNull()
    expect(hubTokenText(400)).toBeNull()
    expect(hubTokenText(12_400)).toBe('12k')
    const out = html(view([child('a'), child('b', { lastTurn: { usedTokens: 0, costUsd: null } })]))
    expect(out).not.toContain('0k')
    expect(out).not.toContain('tokens')
    expect(html(view([child('a', { lastTurn: { usedTokens: 12_400, costUsd: null } })]))).toContain('12k tokens')
  })

  it('names this chat in its own state, so a row with no running child does not read Working', () => {
    const out = html(view([child('a'), child('b')], { state: 'working' }))
    expect(out).toContain('2 open · 0 running')
    expect(out).toContain('This chat is working')
    expect(out).not.toContain('>Working<')
  })

  it('says the updates are waiting, what for, and offers Show now', () => {
    const out = html(view([child('a')], { heldUpdates: 2 }))
    expect(out).toContain('2 updates waiting')
    expect(out).toContain('Show now')
    expect(out).toContain(HUB_HELD_UPDATES_HINT)
    expect(out).not.toContain('Deliver')
    expect(html(view([child('a')], { heldUpdates: 1 }))).toContain('1 update waiting')
  })

  it('offers Resume on a stopped child only', () => {
    expect(html(view([child('a')]))).toContain('>Resume<')
    expect(html(view([child('a', { state: 'failed' })]))).toContain('>Resume<')
    expect(html(view([child('a', { state: 'limited', limit: 'armed' })]))).toContain('>Resume<')
    expect(html(view([child('a', { state: 'working' })]))).not.toContain('>Resume<')
    expect(html(view([child('a', { state: 'starting', waitingForSlot: true })]))).not.toContain('>Resume<')
    // A child on another machine resumes there.
    const remote = { machineId: 'vm-1', machine: 'build-vm', connected: true, ageMs: 0, stopping: false }
    expect(html(view([child('a', { remote })]))).not.toContain('>Resume<')
    // Nudge stays beside it.
    expect(html(view([child('a')]))).toContain('>Nudge<')
  })

  it('shows nothing at all for a chat with no children and no updates', () => {
    expect(html(view([]))).toBe('')
  })
})

describe('the Hub chip dot', () => {
  it('takes the most urgent child state', () => {
    expect(hubChipDot([child('a'), child('b', { state: 'working' })])).toBe('working')
    expect(hubChipDot([child('a', { state: 'working' }), child('b', { state: 'limited' })])).toBe('limited')
    expect(hubChipDot([child('a', { state: 'limited' }), child('b', { state: 'needs_you' })])).toBe('needs-you')
    expect(hubChipDot([child('a', { state: 'result_ready' })])).toBe('finished')
    expect(hubChipDot([child('a')])).toBe('idle')
    expect(hubChipDot([])).toBe('idle')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HubChildrenList } from '../../src/renderer/components/hub/HubChildrenList'
import { HubBatchRows } from '../../src/renderer/components/hub/HubBatchRows'
import { HubChip } from '../../src/renderer/components/hub/HubChip'
import type { HubBatchRowView, HubChatRef, HubChildView, HubRemoteChildNote } from '../../src/shared/hub'

const ref = (id: string, title: string): HubChatRef => ({
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

const offline: HubRemoteChildNote = {
  machineId: 'vm-1',
  machine: 'build-vm',
  connected: false,
  ageMs: 3 * 3_600_000,
  stopping: false,
}

const strip = (items: HubChildView[]) =>
  renderToStaticMarkup(
    createElement(HubChildrenList, {
      view: { self: ref('p', 'Parent'), parent: null, children: items, state: null },
      onDone: () => {},
    }),
  )

const row = (extra: Partial<HubBatchRowView> = {}): HubBatchRowView => ({
  title: 'Fix it',
  agent: 'claude-code',
  account: null,
  model: 'opus',
  mode: 'auto',
  location: 'worktree',
  baseRef: 'main',
  deps: 'link',
  machine: null,
  ...extra,
})

describe('hub UI for children on other machines', () => {
  it('adds nothing to local children (the flag off serves no remote field)', () => {
    const html = strip([child('a'), child('b')])
    expect(html).not.toContain('hub-machine-badge')
    expect(html).not.toContain('data-dot="unknown"')
    expect(html).not.toContain('>Stop<')
    expect(
      renderToStaticMarkup(
        createElement(HubChip, { view: { self: null, parent: null, children: [child('a'), child('b')], state: null } }),
      ),
    ).toContain('2 children</span>')
    const card = renderToStaticMarkup(
      createElement(HubBatchRows, {
        view: { batchId: 'b', rows: [row()], needBytes: null, freeBytes: null, mainCheckout: false },
      }),
    )
    expect(card).not.toContain('hub-machine-badge')
    expect(card).toContain('Claude Code opus · auto · worktree off main · deps: link')
  })

  it('badges a remote child, shows its machine offline with an Unknown dot, and keeps Stop', () => {
    const html = strip([child('a'), child('r', { remote: offline })])
    expect(html).toContain('data-testid="hub-machine-badge"')
    expect(html).toContain('data-dot="unknown"')
    expect(html).toContain('build-vm offline, last seen 3 h ago')
    expect(html).toContain('>Stop<')
  })

  it('counts machines on the Hub chip and badges the card row with its transport', () => {
    const view = { self: null, parent: null, children: [child('a'), child('r', { remote: offline })], state: null }
    expect(renderToStaticMarkup(createElement(HubChip, { view }))).toContain('2 children on 2 machines')
    const card = renderToStaticMarkup(
      createElement(HubBatchRows, {
        view: {
          batchId: 'b',
          rows: [row({ account: 'claude-vm', machine: { id: 'vm-1', name: 'build-vm', transport: 'gcloud-iap' } })],
          needBytes: null,
          freeBytes: null,
          mainCheckout: false,
        },
      }),
    )
    expect(card).toContain('Claude Code opus · claude-vm')
    expect(card).toContain('build-vm · IAP')
    expect(card).toContain(' · auto · worktree off main · deps: link')
  })
})

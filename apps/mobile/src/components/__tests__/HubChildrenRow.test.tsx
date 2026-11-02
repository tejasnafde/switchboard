/**
 * The Hub row renders the shared rules' text: every childStateText and
 * childrenCount case of `tests/fixtures/hub-cases.json` as the phone shows it.
 */
import React from 'react'
import { Alert } from 'react-native'
import TestRenderer, { act } from 'react-test-renderer'
import type { HubChatRef, HubChatView, HubChildView, HubRemoteChildNote } from '@shared/hub'
import type { RuntimeEvent } from '@shared/provider-events'
import type { SwitchboardClient } from '../../lib/api'
import { renderComponent } from '../../test/render'
import { HubChildrenRow } from '../HubChildrenRow'

const cases = require('../../../../../tests/fixtures/hub-cases.json') as {
  childStateText: Array<{
    name: string
    input: Pick<HubChildView, 'state' | 'waitingForSlot' | 'remote'>
    expected: { label: string; word: string }
  }>
  childrenCount: Array<{ name: string; input: Array<string | null>; expected: string }>
}

const ref = (id: string, title = id): HubChatRef => ({
  id,
  familyIds: [id, `${id}-live`],
  title,
  agentType: 'claude-code',
  projectPath: '/p',
  updatedAt: 0,
})

const remote = (machine: string, over: Partial<HubRemoteChildNote> = {}): HubRemoteChildNote => ({
  machineId: machine,
  machine,
  connected: true,
  ageMs: 0,
  stopping: false,
  ...over,
})

function child(id: string, over: Partial<HubChildView> = {}): HubChildView {
  return {
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
    ...over,
  }
}

const parentView = (children: HubChildView[]): HubChatView => ({ self: ref('p1'), parent: null, children, state: null })

function fakeClient(initial: HubChatView) {
  let view = initial
  const handlers = new Set<(event: RuntimeEvent) => void>()
  const client = {
    hubListChildren: jest.fn(async () => view),
    hubStopChildren: jest.fn(async () => {}),
    interrupt: jest.fn(async () => ({ live: true })),
    onEvent: (handler: (event: RuntimeEvent) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  const emit = (threadId: string, next?: HubChatView) => {
    if (next) view = next
    for (const handler of handlers) handler({ type: 'hub.children-changed', threadId })
  }
  return { client, emit, handlers, asClient: client as unknown as SwitchboardClient }
}

const flush = () => act(async () => {})

async function renderRow(view: HubChatView, remoteOn = true, onOpenChat = jest.fn()) {
  const fake = fakeClient(view)
  const root = renderComponent(
    <HubChildrenRow client={fake.asClient} threadId="p1" remoteOn={remoteOn} onOpenChat={onOpenChat} />,
  )
  await flush()
  return { ...fake, root, onOpenChat }
}

async function expand(root: Awaited<ReturnType<typeof renderRow>>['root']) {
  await act(async () => root.byLabel(/^Hub · /).props.onPress())
}

describe('hub-cases.json on the phone', () => {
  it.each(cases.childStateText)('state text: $name', async ({ input, expected }) => {
    const { root } = await renderRow(parentView([child('c1', input)]))
    await expand(root)
    expect(root.texts()).toContain(expected.label)
  })

  it.each(cases.childrenCount)('children count: $name', async ({ input, expected }) => {
    const children = input.map((machine, i) => child(`c${i}`, machine ? { remote: remote(machine) } : {}))
    const { root } = await renderRow(parentView(children))
    expect(root.texts()).toContain(`Hub · ${expected}`)
  })
})

it('renders nothing for a chat without children, and appears on hub.children-changed', async () => {
  const { root, emit } = await renderRow({ self: null, parent: null, children: [], state: null })
  expect(root.texts()).toEqual([])
  emit('p1', parentView([child('c1', { state: 'working' })]))
  await flush()
  expect(root.texts()).toContain('Hub · 1 child')
})

it('re-reads only for its own parent once it has a view, and stops listening on unmount', async () => {
  const { client, emit, handlers, asClient } = fakeClient(parentView([child('c1')]))
  let tree: TestRenderer.ReactTestRenderer | undefined
  await act(async () => {
    tree = TestRenderer.create(
      <HubChildrenRow client={asClient} threadId="p1" remoteOn={false} onOpenChat={jest.fn()} />,
    )
  })
  expect(client.hubListChildren).toHaveBeenCalledTimes(1)
  emit('another-parent')
  await flush()
  expect(client.hubListChildren).toHaveBeenCalledTimes(1)
  emit('p1-live')
  await flush()
  expect(client.hubListChildren).toHaveBeenCalledTimes(2)
  act(() => tree?.unmount())
  expect(handlers.size).toBe(0)
})

it('lists the children with Open and Stop, and stops one through interrupt or all through hub-stop-children', async () => {
  const { root, client, onOpenChat } = await renderRow(
    parentView([
      child('c1', { state: 'working', liveId: 'live-c1', lastWake: { kind: 'report', summary: 'Tests pass' } }),
      child('c2', { state: 'result_ready' }),
    ]),
  )
  expect(root.allByLabel('Stop all')).toHaveLength(0)
  await expand(root)
  expect(root.texts()).toContain('Working: Tests pass')
  expect(root.allByLabel('Stop Child c2')).toHaveLength(0)
  await act(async () => root.byLabel('Stop Child c1').props.onPress())
  expect(client.interrupt).toHaveBeenCalledWith('live-c1')
  await act(async () => root.byLabel('Stop all').props.onPress())
  expect(client.hubStopChildren).toHaveBeenCalledWith('p1')
  await act(async () => root.byLabel('Open Child c2').props.onPress())
  expect(onOpenChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'c2' }))
})

it("shows a remote child's machine, stops it by its own id, and opens its newest report", async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { root, client, onOpenChat } = await renderRow(
    parentView([
      child('c1', {
        state: 'working',
        remote: remote('build-vm'),
        lastWake: { kind: 'report', summary: 'Opened the PR' },
      }),
    ]),
  )
  await expand(root)
  expect(root.texts()).toContain('build-vm')
  await act(async () => root.byLabel('Stop Child c1').props.onPress())
  expect(client.interrupt).toHaveBeenCalledWith('c1')
  await act(async () => root.byLabel('Open Child c1').props.onPress())
  expect(onOpenChat).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('Child c1', 'build-vm · Working\n\nOpened the PR\n\nRead on the desktop.')
  alert.mockRestore()
})

it("hides a remote child's machine while hub_remote_children is off, and never opens it as an empty chat", async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})
  const { root, client, onOpenChat } = await renderRow(
    parentView([child('c1', { state: 'working', remote: remote('build-vm') }), child('c2')]),
    false,
  )
  expect(root.texts()).toContain('Hub · 2 children')
  await expand(root)
  expect(root.texts()).not.toContain('build-vm')
  expect(root.texts()).toContain('Working')
  await act(async () => root.byLabel('Stop Child c1').props.onPress())
  expect(client.interrupt).toHaveBeenCalledWith('c1')
  await act(async () => root.byLabel('Open Child c1').props.onPress())
  expect(onOpenChat).not.toHaveBeenCalled()
  expect(alert).toHaveBeenCalledWith('Child c1', 'Working\n\nNo report yet.\n\nRead on the desktop.')
  alert.mockRestore()
})

it('shows a failed read with Retry, and Retry reads again', async () => {
  const fake = fakeClient(parentView([child('c1')]))
  fake.client.hubListChildren.mockRejectedValueOnce(new Error('backend busy'))
  const root = renderComponent(
    <HubChildrenRow client={fake.asClient} threadId="p1" remoteOn={false} onOpenChat={jest.fn()} />,
  )
  await flush()
  expect(root.texts().join('')).toContain('Could not read the child chats: backend busy')
  await act(async () => root.byLabel('Retry').props.onPress())
  await flush()
  expect(fake.client.hubListChildren).toHaveBeenCalledTimes(2)
  expect(root.texts()).toContain('Hub · 1 child')
  expect(root.allByLabel('Retry')).toHaveLength(0)
})

it('keeps the expanded children in a bounded scroll area', async () => {
  const { root } = await renderRow(parentView(Array.from({ length: 12 }, (_, i) => child(`c${i}`))))
  await expand(root)
  const list = root.root.findAll((n) => n.props.testID === 'hub-children-list' && typeof n.type === 'string')
  expect(list).toHaveLength(1)
  expect(list[0].findAll((n) => n.props.testID === 'hub-child-row' && typeof n.type === 'string')).toHaveLength(12)
  expect(JSON.stringify(list[0].props.style)).toContain('"maxHeight":240')
})

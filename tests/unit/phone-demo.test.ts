import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DemoTransport,
  NOT_IN_DEMO,
  loadDemoData,
  materialize,
  scriptFor,
  withoutDemo,
  type DemoData,
} from '../../src/shared/phone-demo/phone-demo'
import { AppChannels, ProviderChannels, PullRequestChannels } from '../../src/shared/ipc-channels'
import { REQUEST_EXPIRED, type RuntimeEvent } from '../../src/shared/provider-events'
import type { PrDetail, PrListData, PrResult } from '../../src/shared/pull-requests'

const NOW = 1_800_000_000_000

function collect(transport: DemoTransport): RuntimeEvent[] {
  const events: RuntimeEvent[] = []
  transport.on(ProviderChannels.EVENT, (event: RuntimeEvent) => events.push(event))
  return events
}

describe('phone demo fixture', () => {
  const data: DemoData = loadDemoData(NOW)

  it('replaces every @now token with a time', () => {
    expect(JSON.stringify(data)).not.toContain('@now')
    expect(materialize({ a: '@now-500', b: ['@now'], c: '@nowhere' }, 1000)).toEqual({
      a: 500,
      b: [1000],
      c: '@nowhere',
    })
  })

  it('has one project with a running chat, an approval chat and a finished chat', () => {
    expect(data.project.name).toBe('acme-console')
    expect(data.chats.map((c) => c.id)).toEqual(['demo-approval', 'demo-running', 'demo-done'])
    expect(data.chats[0].pending).toHaveLength(1)
    expect(data.chats[0].pending[0]).toMatchObject({ type: 'request.opened', toolName: 'Bash' })
    const done = data.chats[2].messages
    expect(done.some((m) => m.content.includes('```mermaid'))).toBe(true)
    expect(done.filter((m) => m.fileDiff)).toHaveLength(3)
  })

  it('fills @thread and @message in global scripts', () => {
    const steps = scriptFor(data, 'demo-done', 'reply', 'm-1')
    expect(steps.map((s) => s.event.threadId)).toEqual(['demo-done', 'demo-done', 'demo-done', 'demo-done'])
    expect(steps.find((s) => s.event.type === 'content')).toMatchObject({ event: { messageId: 'm-1' } })
  })

  it('lets a chat script override the global one', () => {
    const steps = scriptFor(data, 'demo-running', 'interrupt', 'm-1')
    expect(steps[0].event).toMatchObject({ type: 'tool.completed', toolId: 'demo-running-t4' })
  })

  it('scripts only reference chats that exist', () => {
    const ids = new Set(data.chats.map((c) => c.id))
    for (const chat of data.chats) {
      for (const steps of Object.values(chat.scripts)) {
        for (const step of steps ?? []) expect(ids.has(step.event.threadId)).toBe(true)
      }
    }
  })
})

describe('withoutDemo', () => {
  it('drops the demo connection and its threads, nothing else', () => {
    expect(withoutDemo({ demo: 1, 'demo:t1': 2, 'mac:t1': 3, mac: 4, 'demolition:t': 5 })).toEqual({
      'mac:t1': 3,
      mac: 4,
      'demolition:t': 5,
    })
  })
})

describe('DemoTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('plays nothing until the app subscribes, then the connect scripts', async () => {
    const transport = new DemoTransport(() => NOW)
    await vi.advanceTimersByTimeAsync(10_000)
    const events = collect(transport)
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toContainEqual({ type: 'status', threadId: 'demo-running', status: 'running' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'request.opened', threadId: 'demo-approval' }))
    await vi.advanceTimersByTimeAsync(10_000)
    const last = events.at(-1)
    // The running turn stays running on its last edit.
    expect(last).toMatchObject({ type: 'tool.started', toolId: 'demo-running-t4' })
    expect(transport.statusOf('demo-running')).toBe('running')
    transport.close()
  })

  it('approve runs the tests and clears the pending request', async () => {
    const transport = new DemoTransport(() => NOW)
    const events = collect(transport)
    await vi.advanceTimersByTimeAsync(0)
    expect(await transport.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'demo-approval')).toHaveLength(1)
    await transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'demo-approval', 'demo-approval-request', 'approve')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.completed', toolId: 'demo-approval-t3' }))
    expect(transport.statusOf('demo-approval')).toBe('idle')
    expect(await transport.invoke(ProviderChannels.GET_PENDING_REQUESTS, 'demo-approval')).toEqual([])
    await expect(
      transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'demo-approval', 'demo-approval-request', 'deny'),
    ).rejects.toThrow(REQUEST_EXPIRED)
    transport.close()
  })

  it('deny skips the tests', async () => {
    const transport = new DemoTransport(() => NOW)
    const events = collect(transport)
    await transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'demo-approval', 'demo-approval-request', 'deny')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(events.some((e) => e.type === 'tool.started' && e.threadId === 'demo-approval')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'content', messageId: 'demo-approval-a5' }))
    transport.close()
  })

  it('a send echoes the message, then plays the scripted reply', async () => {
    const transport = new DemoTransport(() => NOW)
    const events = collect(transport)
    await vi.advanceTimersByTimeAsync(10_000)
    events.length = 0
    const result = await transport.invoke(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1,
      threadId: 'demo-done',
      origin: 'o-1',
      providerText: 'hello',
    })
    expect(result).toMatchObject({ status: 'accepted' })
    expect(events[0]).toMatchObject({ type: 'user.message', threadId: 'demo-done', origin: 'o-1', text: 'hello' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(events.at(-1)).toEqual({ type: 'status', threadId: 'demo-done', status: 'idle' })
    expect(events.some((e) => e.type === 'content' && e.text.includes('scripted'))).toBe(true)
    transport.close()
  })

  it('stop ends the running turn and cancels the rest of its script', async () => {
    const transport = new DemoTransport(() => NOW)
    const events = collect(transport)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await transport.invoke(ProviderChannels.INTERRUPT, 'demo-running')).toEqual({ live: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events.some((e) => e.type === 'tool.started' && e.toolId === 'demo-running-t4')).toBe(false)
    expect(transport.statusOf('demo-running')).toBe('idle')
    expect(await transport.invoke(ProviderChannels.INTERRUPT, 'demo-done')).toEqual({ live: false })
    transport.close()
  })

  it('answers the list and pull request channels from the fixture', async () => {
    const transport = new DemoTransport(() => NOW)
    const rows = await transport.invoke<Array<{ id: string }>>(AppChannels.GET_CONVERSATIONS, '/demo/acme-console')
    expect(rows.map((r) => r.id)).toEqual(['demo-approval', 'demo-running', 'demo-done'])
    const session = await transport.invoke(AppChannels.LOAD_SESSION_BY_ID, 'demo-done', { limit: 200 })
    expect(session).toMatchObject({ meta: { id: 'demo-done', worktreeBranch: 'fix/upload-retry' } })
    const list = await transport.invoke<PrResult<PrListData>>(PullRequestChannels.LIST)
    expect(list.ok && list.data.prs.map((p) => p.ref.number)).toEqual([214, 209, 212, 215, 205])
    expect(list.ok && 'detail' in list.data.prs[0]).toBe(false)
    const detail = await transport.invoke<PrResult<PrDetail>>(
      PullRequestChannels.DETAIL,
      list.ok && list.data.prs[2].ref,
    )
    expect(detail).toMatchObject({
      ok: true,
      data: { title: 'Retry uploads when a signed URL expires', mergeBlockers: [] },
    })
    const linked = await transport.invoke<Array<{ id: string }>>(
      PullRequestChannels.LINKED_CHATS,
      list.ok && list.data.prs[2].ref,
    )
    expect(linked.map((c) => c.id)).toEqual(['demo-done'])
    transport.close()
  })

  it('refuses what the demo cannot do', async () => {
    const transport = new DemoTransport(() => NOW)
    await expect(transport.invoke(AppChannels.FORK_CONVERSATION, {})).rejects.toThrow(NOT_IN_DEMO)
    await expect(
      transport.invoke(ProviderChannels.START_SESSION, { threadId: 'new-chat', provider: 'claude', cwd: '/x' }),
    ).rejects.toThrow(NOT_IN_DEMO)
    transport.close()
  })

  it('opens no socket and makes no request through a whole session', async () => {
    const WebSocket = vi.fn()
    const fetch = vi.fn()
    const XMLHttpRequest = vi.fn()
    vi.stubGlobal('WebSocket', WebSocket)
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('XMLHttpRequest', XMLHttpRequest)
    const transport = new DemoTransport(() => NOW)
    collect(transport)
    for (const channel of [AppChannels.GET_PROJECTS, PullRequestChannels.LIST, 'server:version']) {
      await transport.invoke(channel)
    }
    await transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, 'demo-approval', 'demo-approval-request', 'approve')
    await transport.invoke(ProviderChannels.SEND_TURN, 'demo-done', 'hi', 'sandbox', undefined, 'o-2')
    await vi.advanceTimersByTimeAsync(30_000)
    transport.close()
    expect(WebSocket).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(XMLHttpRequest).not.toHaveBeenCalled()
  })

  it('emits nothing after close', async () => {
    const transport = new DemoTransport(() => NOW)
    const events = collect(transport)
    transport.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(events).toEqual([])
    expect(transport.isAlive()).toBe(false)
    await expect(transport.invoke(AppChannels.GET_PROJECTS)).rejects.toThrow('The demo has ended')
  })
})

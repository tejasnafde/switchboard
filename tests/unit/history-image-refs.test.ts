/** Windowed history sends images by reference only when asked, and serves the bytes back. */
import { describe, expect, it, vi } from 'vitest'
import { dataUrlBytes, imagesByReference } from '../../src/shared/history-image-refs'
import type { ChatMessage } from '../../src/shared/types'

const png = `data:image/png;base64,${Buffer.from('0123456789').toString('base64')}`
const history: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'look', timestamp: 1, images: [{ url: png, mimeType: 'image/png' }, { url: 'https://x/y.png' }] },
  { id: 'a1', role: 'assistant', content: 'ok', timestamp: 2 },
]

const loads = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end: () => {} }) }))
vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  getConversationById: (id: string) => id === 'gone' ? undefined : ({ id, project_path: '/repo', agent_type: 'claude-code', title: 'Chat', status_line: 'x' }),
  resolveRootThreadId: () => 'root',
  getSessionLayout: () => null,
  getConversationForkMetadata: () => null,
}))
vi.mock('../../src/main/conversations/history', () => ({
  loadConversationHistory: async () => {
    loads.count += 1
    await Promise.resolve()
    return { messages: history, diskMessageCount: 2, databaseMessageCount: 0, familyIds: ['c1'] }
  },
}))

const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')

function handlers() {
  const map = new Map<string, (...args: unknown[]) => Promise<any>>()
  registerAppHandlers({ handle: (c: string, h: (...args: unknown[]) => Promise<any>) => map.set(c, h), emit: () => {} } as never, {})
  return map
}

describe('imagesByReference', () => {
  it('swaps data URLs for references and keeps remote images', () => {
    const seen: string[] = []
    const [user, assistant] = imagesByReference(history, (id, index, url) => seen.push(`${id}:${index}:${url === png}`))
    expect(user.images).toEqual([
      { url: '', mimeType: 'image/png', ref: { messageId: 'u1', index: 0, bytes: 10 } },
      { url: 'https://x/y.png' },
    ])
    expect(assistant).toBe(history[1])
    expect(seen).toEqual(['u1:0:true'])
  })

  it('computes decoded sizes from base64 padding', () => {
    expect(dataUrlBytes(`data:a;base64,${Buffer.from('a').toString('base64')}`)).toBe(1)
    expect(dataUrlBytes(`data:a;base64,${Buffer.from('ab').toString('base64')}`)).toBe(2)
    expect(dataUrlBytes(`data:a;base64,${Buffer.from('abc').toString('base64')}`)).toBe(3)
  })
})

describe('load-session-by-id image references', () => {
  it('keeps data URLs for a client that does not ask (phones, older desktops)', async () => {
    const resp = await handlers().get(AppChannels.LOAD_SESSION_BY_ID)!('c1', { window: true, limit: 200 })
    expect(resp.messages[0].images[0].url).toBe(png)
  })

  it('sends references when asked and serves the bytes without a reload', async () => {
    const map = handlers()
    const resp = await map.get(AppChannels.LOAD_SESSION_BY_ID)!('c1', { window: true, limit: 200, imageRefs: true })
    expect(resp.messages[0].images[0]).toMatchObject({ url: '', ref: { messageId: 'u1', index: 0 } })
    expect(JSON.stringify(resp)).not.toContain('base64')
    const before = loads.count
    expect(await map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c1', 'u1', 0)).toEqual({ url: png })
    expect(loads.count).toBe(before)
  })

  it('falls back to the history for an image it has not sent, and misses cleanly', async () => {
    const map = handlers()
    const before = loads.count
    expect(await map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c2', 'u1', 1)).toEqual({ url: 'https://x/y.png' })
    expect(loads.count).toBe(before + 1)
    expect(await map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c2', 'nope', 0)).toEqual({ url: null })
    expect(await map.get(AppChannels.LOAD_HISTORY_IMAGE)!('gone', 'u1', 0)).toEqual({ url: null })
  })

  it('shares one history read between images that miss at the same time', async () => {
    const map = handlers()
    const before = loads.count
    const answers = await Promise.all([
      map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c3', 'nope', 0),
      map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c3', 'nope', 1),
      map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c4', 'nope', 2),
    ])
    expect(answers).toEqual([{ url: null }, { url: null }, { url: null }])
    expect(loads.count).toBe(before + 1)
    // A later miss reads again: only reads in flight are shared.
    await map.get(AppChannels.LOAD_HISTORY_IMAGE)!('c3', 'nope', 0)
    expect(loads.count).toBe(before + 2)
  })
})

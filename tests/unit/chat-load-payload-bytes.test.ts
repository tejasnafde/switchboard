/** The chat.load span carries the UTF-8 size of what load-by-id returns. */
import { expect, it, vi } from 'vitest'

const { end } = vi.hoisted(() => ({ end: vi.fn() }))
vi.mock('../../src/main/perf', () => ({ perfSpan: () => ({ end }) }))
vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  getConversationById: (id: string) => ({ id, project_path: '/repo', agent_type: 'claude-code', title: 'Chat', status_line: 'x' }),
  resolveRootThreadId: (id: string) => id,
  getSessionLayout: () => null,
  getConversationForkMetadata: () => null,
}))
vi.mock('../../src/main/conversations/history', () => ({
  loadConversationHistory: async () => ({
    messages: [{ id: 'a1', role: 'assistant', content: 'héllo', timestamp: 1 }],
    diskMessageCount: 1, databaseMessageCount: 0, familyIds: ['c1'],
  }),
}))

const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')

it('reports payloadBytes as the serialized response size', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerAppHandlers({ handle: (c: string, h: (...args: unknown[]) => unknown) => handlers.set(c, h), emit: () => {} } as never, {})
  const response = await handlers.get(AppChannels.LOAD_SESSION_BY_ID)!('c1')
  expect(end).toHaveBeenCalledWith(expect.objectContaining({ payloadBytes: Buffer.byteLength(JSON.stringify(response)) }))
})

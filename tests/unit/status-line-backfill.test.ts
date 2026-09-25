/**
 * A chat whose last turn ended before `status_line` existed gets one the first
 * time its history loads, so the next list shows its summary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'

const rows = new Map<string, { id: string; project_path: string; agent_type: string; title: string; status_line?: string | null }>()
const stored: Array<{ id: string; line: string }> = []
let history: ChatMessage[] = []
let writeTakes = true
const emitted: string[] = []

vi.mock('../../src/main/db/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/db/database')>()),
  getConversationById: (id: string) => rows.get(id),
  resolveRootThreadId: (id: string) => id,
  getSessionLayout: () => null,
  getConversationForkMetadata: () => null,
  setConversationStatusLineIfMissing: (id: string, line: string) => { stored.push({ id, line }); return writeTakes },
}))
vi.mock('../../src/main/conversations/history', () => ({
  loadConversationHistory: async () => ({ messages: history, diskMessageCount: history.length, databaseMessageCount: 0, familyIds: ['c1'] }),
}))

const { registerAppHandlers } = await import('../../src/main/ipc/app')
const { AppChannels } = await import('../../src/shared/ipc-channels')

function loadById(): Promise<unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerAppHandlers({ handle: (c: string, h: (...args: unknown[]) => unknown) => handlers.set(c, h), emit: (channel: string) => { emitted.push(channel) } } as never, {})
  return handlers.get(AppChannels.LOAD_SESSION_BY_ID)!('c1') as Promise<unknown>
}

beforeEach(() => {
  rows.clear()
  stored.length = 0
  emitted.length = 0
  writeTakes = true
  history = [
    { id: 'u1', role: 'user', content: 'fix it', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'Done. <agent_digest>Login fixed</agent_digest>', timestamp: 2 },
  ]
})

describe('status line backfill on history load', () => {
  it('stores the preview of the loaded history when the chat has none', async () => {
    rows.set('c1', { id: 'c1', project_path: '/repo', agent_type: 'claude-code', title: 'Chat', status_line: null })
    await loadById()
    expect(stored).toEqual([{ id: 'c1', line: 'Login fixed' }])
    expect(emitted).toEqual([AppChannels.CONVERSATIONS_CHANGED])
  })

  it('does not notify lists when a turn wrote a line first', async () => {
    rows.set('c1', { id: 'c1', project_path: '/repo', agent_type: 'claude-code', title: 'Chat', status_line: null })
    writeTakes = false
    await loadById()
    expect(emitted).toHaveLength(0)
  })

  it('leaves a stored line alone', async () => {
    rows.set('c1', { id: 'c1', project_path: '/repo', agent_type: 'claude-code', title: 'Chat', status_line: 'Earlier line' })
    await loadById()
    expect(stored).toHaveLength(0)
    expect(emitted).toHaveLength(0)
  })
})

/**
 * Degraded forks (Codex, OpenCode) copy the visible transcript but the new
 * agent process starts cold. Both fork paths must schedule a pending context
 * handoff on the NEW conversation so ChatPanel replays the transcript as a
 * preamble on the fork's first send. The preamble itself is covered in
 * handoff-preamble.test.ts; the rotated-id persistence in
 * conversation-rotation-fallback.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatMessage } from '../../src/shared/types'

// Keep the codex rollout scan away from the real ~/.codex tree.
const fakeHome = mkdtempSync(join(tmpdir(), 'sb-fork-handoff-'))
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})

const sourceMessages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'first question', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'first answer', timestamp: 2 },
  { id: 'm3', role: 'user', content: 'second question', timestamp: 3 },
]

const getConversationById = vi.fn()
const createForkedConversation = vi.fn()
const setConversationPendingHandoff = vi.fn()

vi.mock('../../src/main/db/database', () => ({
  getConversationById: (id: string) => getConversationById(id),
  createForkedConversation: (row: unknown) => createForkedConversation(row),
  bulkSaveMessages: vi.fn(),
  listSessionIdsForThread: (id: string) => [id],
  threadFamilyIds: (id: string) => [id],
  listConversationSegments: vi.fn(() => []),
  conversationSessionHints: vi.fn(() => []),
  getMessagesForConversation: vi.fn(() => []),
  messageRowsToChatMessages: vi.fn(() => sourceMessages),
  getDisplayBodyEnrichments: vi.fn(() => new Map()),
  setConversationPendingHandoff: (id: string, from: string | null) =>
    setConversationPendingHandoff(id, from),
}))

vi.mock('../../src/main/provider/claude-session-migrate', async (orig) => {
  const actual = await orig<typeof import('../../src/main/provider/claude-session-migrate')>()
  return { ...actual, claudeCandidateDirs: () => [], listClaudeSessionCopies: () => [] }
})

vi.mock('../../src/main/provider/codex-session-dirs', () => ({ codexCandidateDirs: () => [] }))

const { forkConversation } = await import('../../src/main/conversations/fork')

function sourceRow(agentType: string) {
  return {
    id: `src-${agentType}`,
    project_path: '/tmp/proj',
    worktree_path: null,
    agent_type: agentType,
    title: 'My chat',
  }
}

beforeEach(() => {
  getConversationById.mockReset()
  createForkedConversation.mockReset()
  setConversationPendingHandoff.mockReset()
})

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe.each(['codex', 'opencode'])('%s fork schedules a context handoff', (agentType) => {
  it('flags the NEW conversation with the source provider', async () => {
    getConversationById.mockReturnValue(sourceRow(agentType))

    const res = await forkConversation({
      sourceConversationId: `src-${agentType}`,
      upToIndex: 1,
    })

    expect(res.resumable).toBe(false)
    expect(setConversationPendingHandoff).toHaveBeenCalledTimes(1)
    expect(setConversationPendingHandoff).toHaveBeenCalledWith(res.conversation.id, agentType)
    // Sanity: the flag rides the fork's own row, not the source's.
    expect(res.conversation.id).not.toBe(`src-${agentType}`)
    expect(createForkedConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: res.conversation.id }),
    )
  })
})

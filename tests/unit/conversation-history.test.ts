import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'

const ROOT = 'agent-root'
const CLAUDE = 'claude-session'
const CODEX = 'codex-session'

const dbMessages = new Map<string, ChatMessage[]>()
const diskMessages = new Map<string, ChatMessage[]>()

vi.mock('../../src/main/db/database', () => ({
  threadFamilyIds: () => [ROOT, CLAUDE],
  conversationSessionHints: () => [CODEX],
  listConversationSegments: () => [],
  getMessagesForConversation: (id: string) => dbMessages.get(id) ?? [],
  messageRowsToChatMessages: (rows: ChatMessage[]) => rows,
  getDisplayBodyEnrichments: () => new Map(),
}))

vi.mock('../../src/main/provider/claude-session-migrate', () => ({
  claudeCandidateDirs: () => ['/claude-work'],
  listClaudeSessionCopies: (_dir: string, id: string) =>
    id === CLAUDE ? [{ path: '/claude-work/transcript.jsonl', mtimeMs: 1 }] : [],
}))

vi.mock('../../src/main/provider/codex-session-dirs', () => ({
  codexCandidateDirs: () => ['/codex-lenskart'],
}))

vi.mock('../../src/main/projects/session-scanner', () => ({
  scanCodexSessionCopies: () => [{
    id: CODEX,
    source: 'codex',
    title: 'Codex',
    startedAt: 1,
    messageCount: 0,
    filePath: '/codex-lenskart/rollout.jsonl',
  }],
}))

vi.mock('../../src/main/agent/jsonl-cache', () => ({
  loadJsonlCached: (path: string) => diskMessages.get(path) ?? null,
}))

const { loadConversationHistory } = await import('../../src/main/conversations/history')

function message(id: string, role: 'user' | 'assistant', content: string, timestamp: number): ChatMessage {
  return { id, role, content, timestamp }
}

describe('loadConversationHistory', () => {
  beforeEach(() => {
    dbMessages.clear()
    diskMessages.clear()
  })

  it('merges a Claude prefix, Codex continuation, and SQLite-only fleet completions', async () => {
    diskMessages.set('/claude-work/transcript.jsonl', [
      message('claude-user', 'user', 'start in Claude', 100),
      message('claude-answer', 'assistant', 'Claude answer', 200),
    ])
    diskMessages.set('/codex-lenskart/rollout.jsonl', [
      message('codex-user', 'user', 'launch the fleet', 300),
      message('codex-answer', 'assistant', 'The fleet is live', 400),
    ])
    dbMessages.set(CLAUDE, [
      message('legacy-claude-user', 'user', 'start in Claude', 110),
      message('db-only-report', 'assistant', 'Tournament report complete', 500),
    ])

    const history = await loadConversationHistory(CLAUDE, '/repo/panel-agent')

    expect(history.messages.map((item) => item.content)).toEqual([
      'start in Claude',
      'Claude answer',
      'launch the fleet',
      'The fleet is live',
      'Tournament report complete',
    ])
    expect(history.familyIds).toEqual([ROOT, CLAUDE])
  })
})

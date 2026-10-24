/**
 * Message search rows and query rule, ported from Android's
 * MessageSearchPresentationTest and MessageSearchCoordinator.
 */
import { describe, it, expect } from 'vitest'
import type { MessageSearchResult } from '../../src/shared/message-search'
import {
  cleanSnippet,
  messageSearchRow,
  searchableQuery,
  searchErrorMessage,
} from '../../apps/mobile/src/lib/message-search'

function result(over: Partial<MessageSearchResult> = {}): MessageSearchResult {
  return {
    messageId: 'message',
    conversationId: 'thread',
    role: 'user',
    content: 'full',
    snippet: '...A  **native**\n\n result...',
    conversationTitle: 'Native app',
    projectPath: '/Users/tejas/repo',
    agentType: 'codex',
    worktreePath: '/worktree',
    worktreeBranch: 'sb/native',
    ...over,
  }
}

describe('messageSearchRow', () => {
  it('removes FTS markers, normalizes whitespace and keeps routing', () => {
    const row = messageSearchRow(result())
    expect(row.snippet).toBe('A native result')
    expect(row.metadata).toBe('repo · You')
    expect(row.title).toBe('Native app')
    expect(row.key).toBe('thread:message')
    expect(row.result.worktreePath).toBe('/worktree')
  })

  it('marks an archived chat and labels the agent role', () => {
    const row = messageSearchRow(result({ role: 'assistant', projectPath: '/repo/', archived: true }))
    expect(row.metadata).toBe('repo · Assistant · Archived')
  })

  it('names an untitled chat and a Windows project path', () => {
    const row = messageSearchRow(result({ conversationTitle: '  ', projectPath: 'C:\\work\\app', role: 'system' }))
    expect(row.title).toBe('Untitled chat')
    expect(row.metadata).toBe('app · System')
  })
})

describe('cleanSnippet', () => {
  it('caps a pathological snippet', () => {
    const snippet = cleanSnippet('x'.repeat(400))
    expect(snippet.length).toBeLessThanOrEqual(241)
    expect(snippet.endsWith('…')).toBe(true)
  })
})

describe('searchErrorMessage', () => {
  it("uses Android's copy for transport failures", () => {
    expect(searchErrorMessage(new Error('invoke timed out: app:search-messages'))).toBe('Search timed out. Retry.')
    expect(searchErrorMessage(new Error('transport queue full: app:search-messages'))).toBe(
      'Machine is busy. Retry search.',
    )
    expect(searchErrorMessage(new Error('WebSocket closed'))).toBe('Machine connection was lost. Retry search.')
    expect(searchErrorMessage(new Error('transport closed'))).toBe('Machine connection changed. Retry search.')
  })

  it('shows a backend error as it is', () => {
    expect(searchErrorMessage(new Error('database is locked'))).toBe('database is locked')
    expect(searchErrorMessage('plain')).toBe('plain')
  })
})

describe('searchableQuery', () => {
  it('needs two characters after trimming', () => {
    expect(searchableQuery(' a ')).toBeNull()
    expect(searchableQuery('  ab ')).toBe('ab')
  })
})

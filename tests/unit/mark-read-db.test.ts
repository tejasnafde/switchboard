/**
 * Shared read state persistence, over a real in-memory database with the
 * app's migrations.
 *
 * Two things are pinned here. The write must NOT touch `updated_at` - that
 * drives sidebar ordering, and reading a chat must not reorder the list. And it
 * must report a missed row, because a session scanned off disk has none and the
 * caller has to know it only broadcast.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import {
  addProject,
  createConversation,
  getConversationById,
  getConversationLastRead,
  setConversationLastRead,
} from '../../src/main/db/database'

beforeEach(() => {
  createMigratedDb()
  addProject('/repo', 'repo')
  createConversation('conv-1', '/repo', 'claude-code', 'Chat')
})

describe('setConversationLastRead', () => {
  it('stamps that conversation and no other', () => {
    createConversation('conv-2', '/repo', 'claude-code', 'Other')
    expect(setConversationLastRead('conv-1', 1700)).toBe(true)
    expect(getConversationLastRead('conv-1')).toBe(1700)
    expect(getConversationLastRead('conv-2')).toBeNull()
  })

  it('leaves updated_at alone, so reading a chat does not reorder the sidebar', () => {
    const before = getConversationById('conv-1')!.updated_at
    setConversationLastRead('conv-1', before + 10_000)
    expect(getConversationById('conv-1')!.updated_at).toBe(before)
  })

  it('reports false for a conversation with no row, rather than throwing', () => {
    expect(setConversationLastRead('scanned-only', 1700)).toBe(false)
  })
})

describe('getConversationLastRead', () => {
  it('returns null for a never-read conversation', () => {
    expect(getConversationLastRead('conv-1')).toBeNull()
  })

  it('returns null when the conversation does not exist', () => {
    expect(getConversationLastRead('nope')).toBeNull()
  })
})

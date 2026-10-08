/**
 * Projects rename/remove over a real in-memory database with the app's
 * migrations. Pins renameProject's (name, path) bind order (the one flip-able
 * bug in the pair) and the schema-level cascade that drops a removed project's
 * conversations.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createMigratedDb } from './helpers/test-db'
import { addProject, createConversation, getConversationById, getProjects, removeProject, renameProject } from '../../src/main/db/database'

beforeEach(() => { createMigratedDb() })

describe('projects rename/remove', () => {
  it('renameProject renames only that project', () => {
    addProject('/repo/a', 'a')
    addProject('/repo/b', 'b')
    renameProject('/repo/a', 'Alpha')
    expect(getProjects().map((p) => [p.path, p.name]).sort()).toEqual([['/repo/a', 'Alpha'], ['/repo/b', 'b']])
  })

  it('removeProject deletes the project and its conversations', () => {
    addProject('/repo/a', 'a')
    addProject('/repo/b', 'b')
    createConversation('c-a', '/repo/a', 'claude-code', 'A chat')
    createConversation('c-b', '/repo/b', 'claude-code', 'B chat')
    removeProject('/repo/a')
    expect(getProjects().map((p) => p.path)).toEqual(['/repo/b'])
    expect(getConversationById('c-a')).toBeUndefined()
    expect(getConversationById('c-b')).toBeDefined()
  })
})

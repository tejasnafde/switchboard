/**
 * Every archive runs the archive listeners, so the registry's cleanup (cards,
 * secret files, links) happens however the chat was archived: from the
 * sidebar or by moving its kanban card to Done.
 */
import { createMigratedDb } from './helpers/test-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addProject,
  archiveConversation,
  createConversation,
  createKanbanCard,
  isConversationArchived,
  updateKanbanCard,
} from '../../src/main/db/database'
import { onConversationArchived } from '../../src/main/db/archive-events'

let archived: string[] = []
let stop: () => void = () => {}

beforeEach(() => {
  createMigratedDb()
  archived = []
  stop = onConversationArchived((id) => archived.push(id))
  addProject('/tmp/project', 'project')
  createConversation('chat', '/tmp/project', 'claude-code', 'A chat')
})

afterEach(() => stop())

describe('archive listeners', () => {
  it('run on a plain archive', () => {
    archiveConversation('chat')
    expect(archived).toEqual(['chat'])
  })

  it('run when a kanban card moves to Done, and not when it moves back out', () => {
    createKanbanCard('card', { projectPath: '/tmp/project', title: 'card' })
    updateKanbanCard('card', { conversationId: 'chat', status: 'in_progress' })
    updateKanbanCard('card', { status: 'done' })
    expect(isConversationArchived('chat')).toBe(true)
    expect(archived).toEqual(['chat'])
    updateKanbanCard('card', { status: 'in_progress' })
    expect(isConversationArchived('chat')).toBe(false)
    expect(archived).toEqual(['chat'])
  })

  it('keep running the others when one throws', () => {
    const off = onConversationArchived(() => {
      throw new Error('listener broke')
    })
    try {
      archiveConversation('chat')
    } finally {
      off()
    }
    expect(archived).toEqual(['chat'])
  })
})

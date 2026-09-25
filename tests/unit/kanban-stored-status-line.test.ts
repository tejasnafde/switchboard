import { describe, expect, it } from 'vitest'
import { storedStatusLine } from '../../src/renderer/components/kanban/KanbanView'
import type { KanbanCard, Project } from '@shared/types'

const projects = new Map<string, Project>([['/repo', {
  path: '/repo',
  name: 'repo',
  sessions: [{ id: 'chat', source: 'claude-code', title: 'Chat', startedAt: 1, messageCount: 0, filePath: '', statusLine: 'Tests pass, PR open' }],
}]])
const card = (conversationId: string | null) => ({ id: 'c', projectPath: '/repo', conversationId }) as KanbanCard

describe('kanban tile stored status line', () => {
  it("reads the linked chat's stored line from the project list", () => {
    expect(storedStatusLine(projects, card('chat'))).toBe('Tests pass, PR open')
  })

  it('has none for a card without a chat, or a chat the list does not hold', () => {
    expect(storedStatusLine(projects, card(null))).toBeUndefined()
    expect(storedStatusLine(projects, card('other'))).toBeUndefined()
  })
})

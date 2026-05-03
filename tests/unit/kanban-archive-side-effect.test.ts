/**
 * The kanban "Done" column doubles as an archive trigger: a card moving
 * INTO done should auto-archive its linked conversation, and moving OUT
 * of done should unarchive it. This pure helper decides which (if any)
 * action to take for a given status transition. Wired into
 * `updateKanbanCard` and the IPC layer; the actual archive/unarchive
 * DB calls live in `database.ts`.
 */
import { describe, it, expect } from 'vitest'
import {
  archiveActionForStatusChange,
  applyKanbanArchiveSideEffect,
} from '../../src/shared/kanbanArchive'
import { vi } from 'vitest'

describe('archiveActionForStatusChange', () => {
  it('returns "archive" when transitioning into done from any other column', () => {
    expect(archiveActionForStatusChange('backlog', 'done')).toBe('archive')
    expect(archiveActionForStatusChange('in_progress', 'done')).toBe('archive')
    expect(archiveActionForStatusChange('needs_input', 'done')).toBe('archive')
  })

  it('returns "unarchive" when transitioning out of done', () => {
    expect(archiveActionForStatusChange('done', 'backlog')).toBe('unarchive')
    expect(archiveActionForStatusChange('done', 'in_progress')).toBe('unarchive')
    expect(archiveActionForStatusChange('done', 'needs_input')).toBe('unarchive')
  })

  it('returns "none" when status does not cross the done boundary', () => {
    expect(archiveActionForStatusChange('backlog', 'in_progress')).toBe('none')
    expect(archiveActionForStatusChange('in_progress', 'needs_input')).toBe('none')
    expect(archiveActionForStatusChange('done', 'done')).toBe('none')
    expect(archiveActionForStatusChange('backlog', 'backlog')).toBe('none')
  })

  it('returns "none" when next is undefined (status not in patch)', () => {
    // updateKanbanCard receives a partial patch — no `status` key means
    // the column isn't changing, so no archive action.
    expect(archiveActionForStatusChange('done', undefined)).toBe('none')
    expect(archiveActionForStatusChange('backlog', undefined)).toBe('none')
  })
})

describe('applyKanbanArchiveSideEffect', () => {
  function makeHooks() {
    return { archive: vi.fn(), unarchive: vi.fn() }
  }

  it('archives the linked conversation when moving into done', () => {
    const hooks = makeHooks()
    applyKanbanArchiveSideEffect(
      { status: 'in_progress', conversationId: 'conv_1' },
      { status: 'done' },
      hooks,
    )
    expect(hooks.archive).toHaveBeenCalledWith('conv_1')
    expect(hooks.unarchive).not.toHaveBeenCalled()
  })

  it('unarchives the linked conversation when moving out of done', () => {
    const hooks = makeHooks()
    applyKanbanArchiveSideEffect(
      { status: 'done', conversationId: 'conv_1' },
      { status: 'in_progress' },
      hooks,
    )
    expect(hooks.unarchive).toHaveBeenCalledWith('conv_1')
    expect(hooks.archive).not.toHaveBeenCalled()
  })

  it('does nothing when the card has no linked conversation', () => {
    const hooks = makeHooks()
    applyKanbanArchiveSideEffect(
      { status: 'in_progress', conversationId: null },
      { status: 'done' },
      hooks,
    )
    expect(hooks.archive).not.toHaveBeenCalled()
    expect(hooks.unarchive).not.toHaveBeenCalled()
  })

  it('does nothing when the patch does not change status', () => {
    const hooks = makeHooks()
    applyKanbanArchiveSideEffect(
      { status: 'done', conversationId: 'conv_1' },
      { status: undefined },
      hooks,
    )
    expect(hooks.archive).not.toHaveBeenCalled()
    expect(hooks.unarchive).not.toHaveBeenCalled()
  })

  it('does nothing for transitions that do not cross the done boundary', () => {
    const hooks = makeHooks()
    applyKanbanArchiveSideEffect(
      { status: 'backlog', conversationId: 'conv_1' },
      { status: 'in_progress' },
      hooks,
    )
    expect(hooks.archive).not.toHaveBeenCalled()
    expect(hooks.unarchive).not.toHaveBeenCalled()
  })
})

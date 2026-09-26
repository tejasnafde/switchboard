import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProject, closeDb, createKanbanCard, getKanbanCard } from '../../src/main/db/database'

const previousDataDir = process.env.SWITCHBOARD_DATA_DIR
const scratch: string[] = []

afterEach(() => {
  closeDb()
  if (previousDataDir === undefined) delete process.env.SWITCHBOARD_DATA_DIR
  else process.env.SWITCHBOARD_DATA_DIR = previousDataDir
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('kanban runtime_mode round trip', () => {
  it('keeps auto instead of coercing it to the default', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-kanban-mode-'))
    scratch.push(root)
    process.env.SWITCHBOARD_DATA_DIR = root

    addProject('/tmp/project', 'project')
    createKanbanCard('card_auto', { projectPath: '/tmp/project', title: 'auto card', runtimeMode: 'auto' })
    expect(getKanbanCard('card_auto')?.runtimeMode).toBe('auto')
  })

  it('keeps a card nobody picked a mode for unset, so the project default applies', () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-kanban-mode-'))
    scratch.push(root)
    process.env.SWITCHBOARD_DATA_DIR = root

    addProject('/tmp/project', 'project')
    createKanbanCard('card_unset', { projectPath: '/tmp/project', title: 'untouched card' })
    createKanbanCard('card_picked', { projectPath: '/tmp/project', title: 'picked card', runtimeMode: 'accept-edits' })
    expect(getKanbanCard('card_unset')?.runtimeMode).toBeNull()
    expect(getKanbanCard('card_picked')?.runtimeMode).toBe('accept-edits')
  })
})

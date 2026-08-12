import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const manager = readFileSync(
  resolve(__dirname, '../../src/renderer/components/sidebar/WorkspaceManager.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')
const sidebar = readFileSync(
  resolve(__dirname, '../../src/renderer/components/sidebar/Sidebar.tsx'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('workspace organizer production structure', () => {
  it('uses a two-pane dialog with sortable workspace and project lists', () => {
    expect(manager).toContain('role="dialog"')
    expect(manager).toContain('className="workspace-organizer-nav"')
    expect(manager).toContain('className="workspace-organizer-detail"')
    expect(manager).toContain('reorderWorkspacesById')
    expect(manager).toContain('reorderProjectsWithinWorkspace')
  })

  it('keeps visual surfaces in theme CSS instead of hardcoded inline colors', () => {
    expect(manager).not.toContain('style={{')
    expect(manager).not.toMatch(/background:\s*['"](?:#|rgb|rgba)/)
  })

  it('persists both workspace and project reordering', () => {
    expect(manager).toContain('window.api.app.workspaces.reorder')
    expect(manager).toContain('window.api.app.organizeProjects')
  })

  it('replaces the stacked footer actions with one Create menu and an organizer button', () => {
    expect(sidebar).toContain('className="sidebar-create-menu')
    expect(sidebar).toContain('New project')
    expect(sidebar).toContain('New workspace')
    expect(sidebar).toContain('New machine')
    expect(sidebar).toContain('aria-label="Organize workspaces and projects"')
  })
})

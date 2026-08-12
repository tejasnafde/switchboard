import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import type { Project, Workspace } from '@shared/types'
import {
  moveProjectToWorkspace,
  projectOrganizationItems,
  reorderProjectsWithinWorkspace,
  reorderWorkspacesById,
} from '@shared/workspaceOrganization'
import { colorTokenForWorkspace } from './sidebar-helpers'

const WORKSPACE_COLORS = [1, 2, 3, 4, 5, 6].map(
  (index) => `var(--workspace-color-${index})`,
)

interface WorkspaceManagerProps {
  workspaces: Workspace[]
  projects: Project[]
  onClose: () => void
  onMutated: () => void
  onWorkspacesChanged: (workspaces: Workspace[]) => void
  onProjectsChanged: (projects: Project[]) => void
  startCreating?: boolean
  initialWorkspaceId?: string | null
}

function GripIcon() {
  return (
    <svg aria-hidden="true" width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      <circle cx="3" cy="3" r="1" />
      <circle cx="7" cy="3" r="1" />
      <circle cx="3" cy="7" r="1" />
      <circle cx="7" cy="7" r="1" />
      <circle cx="3" cy="11" r="1" />
      <circle cx="7" cy="11" r="1" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  )
}

function SortableWorkspaceRow({
  workspace,
  selected,
  projectCount,
  onSelect,
  onKeyboardMove,
}: {
  workspace: Workspace
  selected: boolean
  projectCount: number
  onSelect: () => void
  onKeyboardMove: (direction: -1 | 1) => void
}) {
  const id = `workspace:${workspace.id}`
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const rowStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
    '--workspace-row-color': colorTokenForWorkspace(workspace),
  } as React.CSSProperties

  return (
    <div
      ref={setNodeRef}
      className="workspace-organizer-nav-row"
      data-selected={selected || undefined}
      data-dragging={isDragging || undefined}
      style={rowStyle}
    >
      <button
        type="button"
        className="workspace-organizer-grip"
        aria-label={`Reorder ${workspace.name}`}
        onKeyDown={(event) => {
          if (!event.altKey) return
          if (event.key === 'ArrowUp') { event.preventDefault(); onKeyboardMove(-1) }
          if (event.key === 'ArrowDown') { event.preventDefault(); onKeyboardMove(1) }
        }}
        {...attributes}
        {...listeners}
      >
        <GripIcon />
      </button>
      <button
        type="button"
        className="workspace-organizer-nav-main"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
      >
        <span className="workspace-organizer-color-rail" />
        <span className="workspace-organizer-nav-name">{workspace.name}</span>
        <span className="workspace-organizer-count">{projectCount}</span>
      </button>
    </div>
  )
}

function SortableProjectRow({
  project,
  workspaces,
  onMove,
  onKeyboardMove,
}: {
  project: Project
  workspaces: Workspace[]
  onMove: (workspaceId: string | null) => void
  onKeyboardMove: (direction: -1 | 1) => void
}) {
  const id = `project:${project.path}`
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const rowStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      className="workspace-organizer-project"
      data-dragging={isDragging || undefined}
      style={rowStyle}
    >
      <button
        type="button"
        className="workspace-organizer-grip"
        aria-label={`Reorder ${project.name}`}
        onKeyDown={(event) => {
          if (!event.altKey) return
          if (event.key === 'ArrowUp') { event.preventDefault(); onKeyboardMove(-1) }
          if (event.key === 'ArrowDown') { event.preventDefault(); onKeyboardMove(1) }
        }}
        {...attributes}
        {...listeners}
      >
        <GripIcon />
      </button>
      <span className="workspace-organizer-project-icon"><FolderIcon /></span>
      <span className="workspace-organizer-project-copy">
        <span className="workspace-organizer-project-name">{project.name}</span>
        <span className="workspace-organizer-project-path">{project.path}</span>
      </span>
      <select
        aria-label={`Workspace for ${project.name}`}
        name={`workspace-${project.path}`}
        value={project.workspaceId ?? ''}
        onChange={(event) => onMove(event.target.value || null)}
      >
        <option value="">Ungrouped</option>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
        ))}
      </select>
    </div>
  )
}

export function WorkspaceManager({
  workspaces,
  projects,
  onClose,
  onMutated,
  onWorkspacesChanged,
  onProjectsChanged,
  startCreating = false,
  initialWorkspaceId,
}: WorkspaceManagerProps) {
  const [localWorkspaces, setLocalWorkspaces] = useState(workspaces)
  const [localProjects, setLocalProjects] = useState(projects)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialWorkspaceId === undefined ? (workspaces[0]?.id ?? null) : initialWorkspaceId,
  )
  const [creating, setCreating] = useState(startCreating)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  useEffect(() => setLocalWorkspaces(workspaces), [workspaces])
  useEffect(() => setLocalProjects(projects), [projects])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (creating) { setCreating(false); setNewName(''); return }
      if (renaming) { setRenaming(false); return }
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [creating, onClose, renaming])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLButtonElement>('.workspace-organizer-nav-row[data-selected] .workspace-organizer-nav-main, .workspace-organizer-ungrouped[data-selected]')
        ?.focus()
    })
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return
      const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ))
      if (controls.length === 0) return
      const current = controls.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current === controls.length - 1 ? 0 : current + 1)
      event.preventDefault()
      controls[next].focus()
    }
    document.addEventListener('keydown', trapFocus, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', trapFocus, true)
      previous?.focus()
    }
  }, [])

  const selectedWorkspace = localWorkspaces.find((workspace) => workspace.id === selectedId) ?? null
  const detailStyle = {
    '--workspace-detail-color': selectedWorkspace
      ? colorTokenForWorkspace(selectedWorkspace)
      : 'var(--text-muted)',
  } as React.CSSProperties
  const visibleProjects = useMemo(
    () => localProjects.filter((project) => (project.workspaceId ?? null) === selectedId),
    [localProjects, selectedId],
  )

  const persistProjectOrder = (next: Project[]) => {
    setLocalProjects(next)
    onProjectsChanged(next)
    void window.api.app.organizeProjects(projectOrganizationItems(next)).catch(onMutated)
  }

  const persistWorkspaceOrder = (next: Workspace[]) => {
    setLocalWorkspaces(next)
    onWorkspacesChanged(next)
    void window.api.app.workspaces.reorder(next.map((workspace) => workspace.id)).catch(onMutated)
  }

  const moveWorkspaceBy = (workspaceId: string, direction: -1 | 1) => {
    const index = localWorkspaces.findIndex((workspace) => workspace.id === workspaceId)
    const target = localWorkspaces[index + direction]
    if (!target) return
    persistWorkspaceOrder(reorderWorkspacesById(localWorkspaces, workspaceId, target.id))
  }

  const moveProjectBy = (projectPath: string, direction: -1 | 1) => {
    const index = visibleProjects.findIndex((project) => project.path === projectPath)
    const target = visibleProjects[index + direction]
    if (!target) return
    persistProjectOrder(reorderProjectsWithinWorkspace(localProjects, selectedId, projectPath, target.path))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return
    const active = String(event.active.id)
    const over = String(event.over.id)
    if (active.startsWith('workspace:') && over.startsWith('workspace:')) {
      persistWorkspaceOrder(reorderWorkspacesById(
        localWorkspaces,
        active.slice('workspace:'.length),
        over.slice('workspace:'.length),
      ))
      return
    }
    if (active.startsWith('project:') && over.startsWith('project:')) {
      persistProjectOrder(reorderProjectsWithinWorkspace(
        localProjects,
        selectedId,
        active.slice('project:'.length),
        over.slice('project:'.length),
      ))
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    const created = await window.api.app.workspaces.create({ name })
    const next = [...localWorkspaces, created]
    setLocalWorkspaces(next)
    setSelectedId(created.id)
    setNewName('')
    setCreating(false)
    onMutated()
  }

  const commitRename = async () => {
    if (!selectedWorkspace) return
    const name = renameValue.trim()
    setRenaming(false)
    if (!name || name === selectedWorkspace.name) return
    await window.api.app.workspaces.rename(selectedWorkspace.id, name)
    setLocalWorkspaces((current) => current.map((workspace) => (
      workspace.id === selectedWorkspace.id ? { ...workspace, name } : workspace
    )))
    onMutated()
  }

  const handleColor = async (color: string | null) => {
    if (!selectedWorkspace) return
    await window.api.app.workspaces.recolor(selectedWorkspace.id, color)
    setLocalWorkspaces((current) => current.map((workspace) => (
      workspace.id === selectedWorkspace.id ? { ...workspace, color } : workspace
    )))
    onMutated()
  }

  const handleDelete = async () => {
    if (!selectedWorkspace) return
    if (!window.confirm(`Delete workspace "${selectedWorkspace.name}"? Its projects will move to Ungrouped.`)) return
    await window.api.app.workspaces.delete(selectedWorkspace.id)
    const nextWorkspaces = localWorkspaces.filter((workspace) => workspace.id !== selectedWorkspace.id)
    const nextProjects = localProjects.map((project) => (
      project.workspaceId === selectedWorkspace.id ? { ...project, workspaceId: null } : project
    ))
    setLocalWorkspaces(nextWorkspaces)
    persistProjectOrder(nextProjects)
    setSelectedId(nextWorkspaces[0]?.id ?? null)
    onMutated()
  }

  const handleMoveProject = (projectPath: string, workspaceId: string | null) => {
    const next = moveProjectToWorkspace(localProjects, projectPath, workspaceId)
    persistProjectOrder(next)
  }

  return (
    <div className="workspace-organizer-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div
        ref={dialogRef}
        className="workspace-organizer sb-floating-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-organizer-title"
      >
        <header className="workspace-organizer-header">
          <div>
            <h2 id="workspace-organizer-title">Organize sidebar</h2>
            <p>Reorder workspaces and decide where projects live.</p>
          </div>
          <button type="button" className="workspace-organizer-close" onClick={onClose} aria-label="Close organizer">
            <CloseIcon />
          </button>
        </header>

        <DndContext sensors={sensors} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
          <div className="workspace-organizer-content">
            <aside className="workspace-organizer-nav" aria-label="Workspaces">
              <div className="workspace-organizer-nav-head">
                <span>Workspaces</span>
                <button type="button" onClick={() => setCreating(true)}>New</button>
              </div>
              {creating && (
                <form className="workspace-organizer-create" onSubmit={(event) => {
                  event.preventDefault()
                  void handleCreate()
                }}>
                  <input
                    autoFocus
                    aria-label="Workspace name"
                    name="workspace-name"
                    autoComplete="off"
                    value={newName}
                    onChange={(event) => setNewName(event.target.value)}
                    placeholder="Workspace name"
                  />
                  <button type="submit" disabled={!newName.trim()}>Add</button>
                </form>
              )}
              <SortableContext
                items={localWorkspaces.map((workspace) => `workspace:${workspace.id}`)}
                strategy={verticalListSortingStrategy}
              >
                <div className="workspace-organizer-nav-list">
                  {localWorkspaces.map((workspace) => (
                    <SortableWorkspaceRow
                      key={workspace.id}
                      workspace={workspace}
                      selected={selectedId === workspace.id}
                      projectCount={localProjects.filter((project) => project.workspaceId === workspace.id).length}
                      onSelect={() => setSelectedId(workspace.id)}
                      onKeyboardMove={(direction) => moveWorkspaceBy(workspace.id, direction)}
                    />
                  ))}
                </div>
              </SortableContext>
              <button
                type="button"
                className="workspace-organizer-ungrouped"
                data-selected={selectedId === null || undefined}
                aria-current={selectedId === null ? 'true' : undefined}
                onClick={() => setSelectedId(null)}
              >
                <span>Ungrouped</span>
                <span className="workspace-organizer-count">
                  {localProjects.filter((project) => !project.workspaceId).length}
                </span>
              </button>
            </aside>

            <main className="workspace-organizer-detail" style={detailStyle}>
              <div className="workspace-organizer-detail-head">
                <div className="workspace-organizer-title-row">
                  {selectedWorkspace && <span className="workspace-organizer-detail-rail" />}
                  {renaming && selectedWorkspace ? (
                    <input
                      autoFocus
                      aria-label="Rename workspace"
                      name="rename-workspace"
                      autoComplete="off"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') { event.preventDefault(); void commitRename() }
                      }}
                    />
                  ) : (
                    <h3>{selectedWorkspace?.name ?? 'Ungrouped'}</h3>
                  )}
                  {selectedWorkspace && !renaming && (
                    <button type="button" className="workspace-organizer-rename" onClick={() => {
                      setRenameValue(selectedWorkspace.name)
                      setRenaming(true)
                    }}>
                      Rename
                    </button>
                  )}
                </div>
                <span>{visibleProjects.length} project{visibleProjects.length === 1 ? '' : 's'}</span>
              </div>

              {selectedWorkspace && (
                <div className="workspace-organizer-toolbar">
                  <span>Color</span>
                  <div className="workspace-organizer-swatches" role="group" aria-label="Workspace color">
                    {WORKSPACE_COLORS.map((color, index) => {
                      const swatchStyle = { '--swatch-color': color } as React.CSSProperties
                      return (
                        <button
                          key={color}
                          type="button"
                          style={swatchStyle}
                          data-selected={selectedWorkspace.color === color || undefined}
                          aria-pressed={selectedWorkspace.color === color}
                          aria-label={`Color ${index + 1}`}
                          onClick={() => void handleColor(color)}
                        />
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    className="workspace-organizer-clear-color"
                    data-selected={!selectedWorkspace.color || undefined}
                    aria-pressed={!selectedWorkspace.color}
                    onClick={() => void handleColor(null)}
                  >
                    Auto
                  </button>
                  <button type="button" className="workspace-organizer-delete" onClick={() => void handleDelete()}>
                    Delete workspace…
                  </button>
                </div>
              )}

              <SortableContext
                items={visibleProjects.map((project) => `project:${project.path}`)}
                strategy={verticalListSortingStrategy}
              >
                <div className="workspace-organizer-project-list">
                  {visibleProjects.map((project) => (
                    <SortableProjectRow
                      key={project.path}
                      project={project}
                      workspaces={localWorkspaces}
                      onMove={(workspaceId) => handleMoveProject(project.path, workspaceId)}
                      onKeyboardMove={(direction) => moveProjectBy(project.path, direction)}
                    />
                  ))}
                  {visibleProjects.length === 0 && (
                    <div className="workspace-organizer-empty">
                      <FolderIcon />
                      <span>No projects here yet.</span>
                      <span>Move one here from another workspace.</span>
                    </div>
                  )}
                </div>
              </SortableContext>
            </main>
          </div>
        </DndContext>

        <footer className="workspace-organizer-footer">
          <span>Drag to reorder · Option + ↑/↓ also works</span>
          <button type="button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}

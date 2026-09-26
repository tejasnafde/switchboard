import { useEffect, useState } from 'react'
import type { WorktreeProtection } from '@shared/worktree-manager'
import { createRendererLogger } from '../../logger'
import { cn } from '../../lib/utils'

const log = createRendererLogger('settings:worktree-protection')

/**
 * Settings > Projects: one switch per project. A protected project's
 * worktrees are never offered for cleanup or counted as stale. Stored on the
 * backend that owns the worktrees, so a remote backend honours it too.
 */
export function WorktreeProtectionPanel() {
  const [projects, setProjects] = useState<Array<{ path: string; name: string }>>([])
  const [protection, setProtection] = useState<WorktreeProtection | null>(null)

  useEffect(() => {
    window.api.app.getProjects()
      .then((rows: Array<{ path: string; name: string }>) => setProjects(rows ?? []))
      .catch((err: unknown) => log.warn('getProjects failed for worktree protection', err))
    window.api.worktreeManager.getProtection()
      .then(setProtection)
      .catch((err: unknown) => log.warn('could not read worktree protection', err))
  }, [])

  const toggle = async (path: string, on: boolean) => {
    try {
      setProtection(await window.api.worktreeManager.setProtection({ target: 'project', path, protected: on }))
    } catch (err) {
      log.warn('could not change worktree protection', path, err)
    }
  }

  if (projects.length === 0) {
    return <div className="text-[12px] text-[var(--text-muted)]">No projects added yet.</div>
  }
  return (
    <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
      {projects.map((project) => {
        const on = protection?.projects.includes(project.path) ?? false
        return (
          <div key={project.path} className="flex items-center gap-4 border-t border-[var(--border)] px-[14px] py-2.5 first:border-t-0">
            <div className="min-w-0 flex-1" title={project.path}>
              <div className="truncate text-[13px] font-[500]">{project.name}</div>
              {on && <div className="text-[12px] text-[var(--text-secondary)]">Protected: worktrees never offered for cleanup</div>}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`Protect worktrees of ${project.name}`}
              disabled={protection === null}
              onClick={() => void toggle(project.path, !on)}
              className={cn(
                'relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full border-0 p-0 outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
                on ? 'bg-[var(--accent)]' : 'bg-[rgba(128,128,128,0.35)]',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'absolute left-[2px] top-[2px] size-[14px] rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-100',
                  on && 'translate-x-[14px]',
                )}
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}

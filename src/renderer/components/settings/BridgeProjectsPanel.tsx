/**
 * Settings > Labs, shown only while the Instinct bridge flag is on: the
 * sidebar's projects, each with a checkbox for whether the bridge may open it.
 * A checked project gets the default policy (auto capped at auto, edits and
 * checks on, commit, push, pull requests, merge and deploy off). None is
 * checked until the owner chooses.
 */
import { useEffect, useState } from 'react'
import type { BridgeProjectSetup } from '@shared/bridge'
import { Checkbox } from '../ui/checkbox'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:bridge')

export function BridgeProjectsPanel() {
  const [setup, setSetup] = useState<BridgeProjectSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.api.bridge
      .listProjects()
      .then((next) => {
        if (live) setSetup(next)
      })
      .catch((err: unknown) => {
        log.warn('reading the bridge projects failed', err)
        if (live) setError('Could not read the projects.')
      })
    return () => {
      live = false
    }
  }, [])

  const toggle = async (path: string, allowed: boolean) => {
    setBusyPath(path)
    setError(null)
    try {
      setSetup(await window.api.bridge.setProjectAllowed(path, allowed))
    } catch (err) {
      log.warn('saving a bridge project failed', err)
      setError(err instanceof Error ? err.message : 'Could not save the change.')
    } finally {
      setBusyPath(null)
    }
  }

  if (!setup?.enabled && !error) return null
  const projects = setup?.projects ?? []
  return (
    <section className="mb-[18px]" data-testid="bridge-projects">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge projects</h3>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
        <p className="m-0 px-[14px] pb-1 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          Instinct and local agents can find and read chats only in the projects you check. New work runs in auto mode
          at most. Commit, push, pull requests, merge and deploy stay off.
        </p>
        {projects.length === 0 && (
          <p className="m-0 px-[14px] py-3 text-[12px] text-[var(--text-muted)]">No projects yet.</p>
        )}
        {projects.map((project) => {
          const id = `bridge-project-${project.path.replace(/\W/g, '-')}`
          return (
            <div
              key={project.path}
              className="flex items-center gap-3 border-t border-[var(--border)] px-[14px] py-2.5 first:border-t-0"
            >
              <Checkbox
                id={id}
                checked={project.allowed}
                disabled={busyPath !== null || project.projectId === null}
                onCheckedChange={(next) => void toggle(project.path, next === true)}
              />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <div className="truncate text-[13px] font-[500] leading-[18px]">{project.name}</div>
                <div className="truncate text-[11px] leading-4 text-[var(--text-muted)]">
                  {project.projectId === null ? 'Folder not found' : project.path}
                </div>
              </label>
            </div>
          )
        })}
        {error && (
          <p
            role="alert"
            className="m-0 border-t border-[var(--border)] px-[14px] py-2 text-[12px] text-[var(--error)]"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

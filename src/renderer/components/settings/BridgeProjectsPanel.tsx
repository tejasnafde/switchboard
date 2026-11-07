/**
 * Settings > Labs, shown only while the Instinct bridge flag is on: the
 * sidebar's projects, each with a checkbox for whether the bridge may open it.
 * The list searches, counts and scrolls inside a fixed height, and one box
 * allows or clears everything the search shows. A checked project gets the
 * default policy (auto capped at auto, edits and checks on, commit, push, pull
 * requests, merge and deploy off; the action flags are recorded only, nothing
 * reads them yet). None is checked until the owner chooses.
 */
import { useEffect, useRef, useState } from 'react'
import type { BridgeProjectSetup, BridgeProjectSetupRow } from '@shared/bridge'
import {
  allShownAllowed,
  BRIDGE_PROJECTS_CHANGED,
  bridgeProjectCountText,
  filterBridgeProjects,
  switchableBridgeProjects,
} from './bridge-setup-model'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:bridge')

export function BridgeProjectsPanel() {
  const [setup, setSetup] = useState<BridgeProjectSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

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

  /** Once per run, not once per write, so a bulk change costs the checklist one read. */
  const announce = () => window.dispatchEvent(new Event(BRIDGE_PROJECTS_CHANGED))

  // Unticking goes by id, so a project whose folder is gone can still be taken off.
  const write = (project: BridgeProjectSetupRow, allowed: boolean): Promise<BridgeProjectSetup> =>
    allowed
      ? window.api.bridge.setProjectAllowed(project.path, true)
      : window.api.bridge.removeProject(project.projectId!)

  const toggle = async (project: BridgeProjectSetupRow, allowed: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setSetup(await write(project, allowed))
    } catch (err) {
      log.warn('saving a bridge project failed', err)
      setError(err instanceof Error ? err.message : 'Could not save the change.')
    } finally {
      setBusy(false)
      announce()
    }
  }

  /** One write per project that changes, so a half-done run still leaves the list true. */
  const toggleShown = async (rows: readonly BridgeProjectSetupRow[], allowed: boolean) => {
    setBusy(true)
    setError(null)
    try {
      for (const project of switchableBridgeProjects(rows)) {
        if (project.allowed === allowed) continue
        setSetup(await write(project, allowed))
      }
    } catch (err) {
      log.warn('saving the shown bridge projects failed', err)
      setError(err instanceof Error ? err.message : 'Could not save every change.')
    } finally {
      setBusy(false)
      announce()
    }
  }

  if (!setup?.enabled && !error) return null
  const projects = setup?.projects ?? []
  const shown = filterBridgeProjects(projects, query)
  const allowedCount = projects.filter((p) => p.allowed).length
  const allShown = allShownAllowed(shown)
  const allShownLabel = allShown ? 'Allow none of the projects shown' : 'Allow every project shown'
  return (
    <section className="mb-[18px]" data-testid="bridge-projects">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge projects</h3>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
        <p className="m-0 px-[14px] pb-2.5 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          The bridge can find, open and message chats only in the projects you tick. Those chats run with your own
          access to this Mac, in auto mode at most.
        </p>
        <div className="flex items-center gap-2 border-t border-[var(--border)] px-[14px] py-2">
          <Input
            ref={searchRef}
            aria-label="Search projects"
            placeholder="Search projects"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 min-w-0 flex-1 bg-[var(--bg-primary)] text-[12px]"
          />
          <span data-testid="bridge-projects-count" className="flex-none text-[11px] text-[var(--text-muted)]">
            {bridgeProjectCountText(projects.length, allowedCount, shown.length)}
          </span>
        </div>
        {shown.length > 0 && (
          <div className="flex items-center gap-3 border-t border-[var(--border)] px-[14px] py-2 text-[12px] text-[var(--text-secondary)]">
            <Checkbox
              id="bridge-allow-shown"
              aria-label={allShownLabel}
              checked={allShown}
              disabled={busy || switchableBridgeProjects(shown).length === 0}
              onCheckedChange={() => void toggleShown(shown, !allShown)}
            />
            <label htmlFor="bridge-allow-shown" className="cursor-pointer">
              {allShownLabel}
            </label>
          </div>
        )}
        <div className="max-h-[240px] overflow-y-auto" data-testid="bridge-projects-list">
          {projects.length === 0 && (
            <p className="m-0 border-t border-[var(--border)] px-[14px] py-3 text-[12px] text-[var(--text-muted)]">
              No projects yet.
            </p>
          )}
          {projects.length > 0 && shown.length === 0 && (
            <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-[14px] py-3">
              <span className="text-[12px] text-[var(--text-muted)]">No project matches that search.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
              >
                Clear search
              </Button>
            </div>
          )}
          {shown.map((project) => {
            const key = project.orphan ? `orphan:${project.projectId}` : project.path
            const id = `bridge-project-${key.replace(/\W/g, '-')}`
            return (
              <div key={key} className="flex items-center gap-3 border-t border-[var(--border)] px-[14px] py-2.5">
                <Checkbox
                  id={id}
                  checked={project.allowed}
                  disabled={busy || project.projectId === null}
                  onCheckedChange={(next) => void toggle(project, next === true)}
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                  <div className="truncate text-[13px] font-[500] leading-[18px]">{project.name}</div>
                  <div data-project-path className="truncate text-[11px] leading-4 text-[var(--text-muted)]">
                    {project.orphan
                      ? 'Not in the sidebar or the folder moved. Untick to remove it.'
                      : project.projectId === null
                        ? 'Folder not found'
                        : project.path}
                  </div>
                </label>
              </div>
            )
          })}
        </div>
        <p className="m-0 border-t border-[var(--border)] px-[14px] py-2 text-[11px] leading-[1.45] text-[var(--text-muted)]">
          Each allowed project also records the actions you permit (edits and checks on; commit, push, pull requests,
          merge and deploy off). Nothing enforces those flags yet.
        </p>
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

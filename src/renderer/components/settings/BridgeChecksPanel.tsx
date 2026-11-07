/**
 * Settings > Labs, shown only while the Instinct bridge flag is on: the named
 * checks each allowed project measures, and the newest recorded run of each.
 *
 * A check is a program and an argument ARRAY, never a shell command line, so
 * the arguments field is split on spaces and stored as a list. A result here
 * is what the local check service observed: the exit code, and whether the
 * source has changed since. Nothing an agent said appears on this panel.
 */
import { useEffect, useState } from 'react'
import type { BridgeCheckResultRow, BridgeChecksSetup, BridgeProjectChecksRow } from '@shared/bridge'
import { BRIDGE_CHECKS_MAX } from '@shared/bridge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:bridge-checks')

/** The owner types arguments as words; the backend only ever stores the list. */
export function splitCheckArgs(text: string): string[] {
  return text.split(/\s+/).filter((a) => a !== '')
}

export function checkResultText(result: BridgeCheckResultRow): string {
  const when = result.at === null ? '' : ` · ${new Date(result.at).toLocaleString()}`
  switch (result.status) {
    case 'measured':
      return `${result.outcome === 'passed' ? 'Passed' : `Failed (exit ${result.exit_code ?? '?'})`}${when}`
    case 'stale':
      return `${result.outcome === 'passed' ? 'Passed' : 'Failed'} on older code${when}`
    case 'unavailable':
      return `Could not run${when}`
    default:
      return 'Not measured'
  }
}

export function BridgeChecksPanel() {
  const [setup, setSetup] = useState<BridgeChecksSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Record<string, { name: string; program: string; args: string }>>({})

  useEffect(() => {
    let live = true
    window.api.bridge
      .listChecks()
      .then((next) => {
        if (live) setSetup(next)
      })
      .catch((err: unknown) => {
        log.warn('reading the bridge checks failed', err)
        if (live) setError('Could not read the checks.')
      })
    return () => {
      live = false
    }
  }, [])

  const save = async (projectId: string, checks: BridgeProjectChecksRow['checks']) => {
    setBusy(true)
    setError(null)
    try {
      setSetup(await window.api.bridge.setChecks(projectId, checks))
    } catch (err) {
      log.warn('saving the bridge checks failed', err)
      setError(err instanceof Error ? err.message : 'Could not save the change.')
    } finally {
      setBusy(false)
    }
  }

  const add = async (project: BridgeProjectChecksRow) => {
    const entry = draft[project.project_id]
    if (!entry?.name.trim() || !entry.program.trim()) return
    await save(project.project_id, [
      ...project.checks,
      { name: entry.name.trim(), program: entry.program.trim(), args: splitCheckArgs(entry.args) },
    ])
    setDraft((d) => ({ ...d, [project.project_id]: { name: '', program: '', args: '' } }))
  }

  if (!setup?.enabled && !error) return null
  const projects = setup?.projects ?? []
  return (
    <section className="mb-[18px]" data-testid="bridge-checks">
      <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">Instinct bridge checks</h3>
      <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
        <p className="m-0 px-[14px] pb-1 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          A check runs once after a bridge turn ends, when the folder has stopped changing. Its exit code is the only
          thing Switchboard reports as measured. What the agent writes about tests is never a result. Each check is a
          program and its arguments, so nothing is run through a shell. At most {BRIDGE_CHECKS_MAX} per project.
        </p>
        {projects.length === 0 && (
          <p className="m-0 px-[14px] py-3 text-[12px] text-[var(--text-muted)]">No allowed projects yet.</p>
        )}
        {projects.map((project) => {
          const entry = draft[project.project_id] ?? { name: '', program: '', args: '' }
          const results = new Map(project.results.map((r) => [r.name, r]))
          return (
            <div key={project.project_id} className="border-t border-[var(--border)] px-[14px] py-2.5 first:border-t-0">
              <div className="text-[13px] font-[500] leading-[18px]">{project.label}</div>
              {project.checks.length === 0 && (
                <div className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
                  No check configured, so every check stays not measured.
                </div>
              )}
              {project.checks.map((check) => {
                const result = results.get(check.name)
                return (
                  <div key={check.name} className="mt-1.5 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] leading-[17px]">{check.name}</div>
                      <div className="truncate text-[11px] leading-4 text-[var(--text-muted)]">
                        <span className="[font-family:var(--font-mono)]">
                          {[check.program, ...check.args].join(' ')}
                        </span>
                        {' · '}
                        {result ? checkResultText(result) : 'Not measured'}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void save(
                          project.project_id,
                          project.checks.filter((c) => c.name !== check.name),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )
              })}
              {project.checks.length < BRIDGE_CHECKS_MAX && (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    aria-label={`Check name for ${project.label}`}
                    value={entry.name}
                    placeholder="Name"
                    disabled={busy}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [project.project_id]: { ...entry, name: e.target.value } }))
                    }
                    className="h-7 w-[120px] text-[12px]"
                  />
                  <Input
                    aria-label={`Check program for ${project.label}`}
                    value={entry.program}
                    placeholder="npm"
                    disabled={busy}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [project.project_id]: { ...entry, program: e.target.value } }))
                    }
                    className="h-7 w-[110px] text-[12px]"
                  />
                  <Input
                    aria-label={`Check arguments for ${project.label}`}
                    value={entry.args}
                    placeholder="run test"
                    disabled={busy}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [project.project_id]: { ...entry, args: e.target.value } }))
                    }
                    className="h-7 min-w-0 flex-1 text-[12px]"
                  />
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void add(project)}>
                    Add
                  </Button>
                </div>
              )}
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

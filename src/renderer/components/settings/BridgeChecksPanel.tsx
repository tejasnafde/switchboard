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
      return `${result.outcome === 'passed' ? 'Passed' : 'Failed'}, not on the code now${when}`
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
        <p className="m-0 px-[14px] pb-2 pt-3 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          A check runs after a bridge turn ends. Its exit code is the only result Switchboard reports as measured, and
          what an agent says about tests never counts.
        </p>
        <details className="group px-[14px] pb-2.5 text-[11.5px] leading-[1.45] text-[var(--text-secondary)]">
          <summary className="-ml-1 inline-flex h-5 cursor-pointer select-none list-none items-center gap-1 rounded-[4px] pl-1 pr-1.5 text-[11px] text-[var(--text-muted)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--switch-focus)] [&::-webkit-details-marker]:hidden">
            <span
              aria-hidden="true"
              className="mb-px ml-px mr-0.5 size-[5px] -rotate-45 border-b-[1.5px] border-r-[1.5px] border-current transition-transform duration-100 group-open:mb-[3px] group-open:rotate-45"
            />
            <span className="group-open:hidden">How a check is measured</span>
            <span className="hidden group-open:inline">Less</span>
          </summary>
          <ul className="m-0 mt-0.5 list-disc pl-[15px]">
            <li>
              A check is a program and its arguments, never a shell line. At most {BRIDGE_CHECKS_MAX} per project.
            </li>
            <li>It runs once the folder has stopped changing, so a result belongs to one state of the code.</li>
            <li>
              A result is flagged when the chat wrote a file that decides what a check runs (package.json, a lock file,
              a Makefile, anything under scripts/). No flag is not proof the check itself is unchanged.
            </li>
            <li>This panel reads no checkout, so a result here is never a claim about the code as it is now.</li>
          </ul>
        </details>
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

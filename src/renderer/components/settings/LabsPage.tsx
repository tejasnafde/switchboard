/**
 * Settings > Labs: one row per staged flag. The switch shows the flag's
 * effective state: forced on by its env var (disabled, nothing to reset), off
 * while the flag it needs is off (disabled, the stored row kept), else the
 * stored `labs.<flag>` row it writes through `setting-values.ts`.
 */
import { useEffect, useRef, useState } from 'react'
import { labsFlag, type LabsFlagId, type LabsFlagState } from '@shared/labs'
import { SETTING_ROW, labsWhen, type SettingRowDef } from './settings-rows'
import { SETTINGS_CHANGED_ELSEWHERE } from '../../services/settings-file-sync'
import { Switch } from '../ui/switch'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('settings:labs')

const LABS_ROWS: readonly SettingRowDef[] = Object.values(SETTING_ROW).filter((row) => row.page === 'labs')
const SECTIONS = [...new Set(LABS_ROWS.map((row) => row.section))]

function rowForFlag(id: LabsFlagId): SettingRowDef {
  return LABS_ROWS.find((row) => row.labs?.flag === id)!
}

/** The flags forced on by their env var in the backend, read on open and after a settings.json save. */
function useForcedFlags(): ReadonlySet<LabsFlagId> {
  const [forced, setForced] = useState<ReadonlySet<LabsFlagId>>(new Set())
  useEffect(() => {
    let live = true
    const read = () =>
      window.api.settings
        .labsState()
        .then((states: LabsFlagState[]) => {
          if (live) setForced(new Set(states.filter((s) => s.forced).map((s) => s.id)))
        })
        .catch((err: unknown) => log.warn('reading the labs state failed; no row shows as forced', err))
    void read()
    window.addEventListener(SETTINGS_CHANGED_ELSEWHERE, read)
    return () => {
      live = false
      window.removeEventListener(SETTINGS_CHANGED_ELSEWHERE, read)
    }
  }, [])
  return forced
}

export function LabsPage({
  values,
  set,
  highlight,
}: {
  values: Readonly<Record<string, string>>
  set: (id: string, value: string) => void
  highlight: string | null
}) {
  const forced = useForcedFlags()
  return (
    <>
      {SECTIONS.map((section) => (
        <section key={section} className="mb-[18px]">
          <h3 className="mb-2 text-[11px] font-[500] leading-4 text-[var(--text-muted)]">{section}</h3>
          <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]">
            {LABS_ROWS.filter((row) => row.section === section).map((row) => (
              <LabsRow
                key={row.id}
                def={row}
                values={values}
                forced={forced}
                set={set}
                highlighted={highlight === row.id}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function LabsRow({
  def,
  values,
  forced,
  set,
  highlighted,
}: {
  def: SettingRowDef
  values: Readonly<Record<string, string>>
  forced: ReadonlySet<LabsFlagId>
  set: (id: string, value: string) => void
  highlighted: boolean
}) {
  const copy = def.labs!
  const flag = copy.flag ? labsFlag(copy.flag) : undefined
  const isForced = flag !== undefined && forced.has(flag.id)
  const parent = flag?.needs ? labsFlag(flag.needs) : undefined
  const parentOff = parent !== undefined && !forced.has(parent.id) && values[parent.setting] !== 'true'
  const stored = values[def.id]
  const on = !parentOff && (isForced || stored === 'true')

  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!highlighted || !el) return
    el.scrollIntoView({ block: 'center' })
    ;(el.querySelector<HTMLElement>('[role="switch"]:not(:disabled), summary') ?? el).focus({ preventScroll: true })
  }, [highlighted])

  const id = (part: string) => `${def.id.replace(/\W/g, '-')}-${part}`
  const describedBy = [id('desc'), copy.warning && id('risk'), id('meta'), isForced && id('more')]
    .filter(Boolean)
    .join(' ')
  const meta = [copy.where, labsWhen(copy)]
  if (parent && parentOff) meta.push(`needs ${rowForFlag(parent.id).label} on`)

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-setting-row={def.id}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 border-t border-[var(--border)] px-[14px] py-3 outline-none first:border-t-0 max-[520px]:gap-x-3 ${highlighted ? 'bg-[var(--accent-subtle)]' : ''}`}
    >
      <div className="min-w-0">
        <div id={id('label')} className="text-[13px] font-[500] leading-[18px]">
          {def.label}
        </div>
        <div id={id('desc')} className="mt-0.5 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
          {def.description}
        </div>
        {copy.warning && (
          <div
            id={id('risk')}
            className="mt-1 flex items-baseline gap-1.5 text-[11.5px] leading-[1.45] text-[var(--text-secondary)]"
          >
            <span
              aria-hidden="true"
              className="size-[5px] flex-none -translate-y-[2px] rounded-full bg-[var(--warning)]"
            />
            <span>{copy.warning}</span>
          </div>
        )}
        <div id={id('meta')} className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]">
          {meta.join(' · ')}
        </div>
      </div>
      {flag ? (
        <div className="flex h-[18px] flex-none items-center gap-2.5">
          <span
            aria-hidden="true"
            className="min-w-14 text-right text-[11px] leading-[18px] text-[var(--text-muted)] max-[520px]:min-w-0"
          >
            {on ? (isForced ? 'Forced on' : 'On') : 'Off'}
          </span>
          <Switch
            checked={on}
            aria-labelledby={id('label')}
            aria-describedby={describedBy}
            disabled={isForced || parentOff || stored === undefined}
            onCheckedChange={(next) => set(def.id, String(next))}
          />
        </div>
      ) : (
        <div className="text-right text-[11px] leading-[18px] text-[var(--text-muted)]">{copy.note}</div>
      )}
      <details className="group col-start-1 mt-1 text-[11.5px] leading-[1.45] text-[var(--text-secondary)]">
        <summary className="-ml-1 inline-flex h-5 cursor-pointer select-none list-none items-center gap-1 rounded-[4px] pl-1 pr-1.5 text-[11px] text-[var(--text-muted)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--switch-focus)] [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className="mb-px ml-px mr-0.5 size-[5px] -rotate-45 border-b-[1.5px] border-r-[1.5px] border-current transition-transform duration-100 group-open:mb-[3px] group-open:rotate-45"
          />
          <span className="group-open:hidden">More</span>
          <span className="hidden group-open:inline">Less</span>
        </summary>
        <div id={id('more')}>
          {isForced && flag.envVar && (
            <p className="mb-0 mt-0.5">
              Forced on: <Code>{flag.envVar}=1</Code> is set in Switchboard's environment. Restart without it to change.
            </p>
          )}
          {copy.more.map((text) => (
            <p key={text} className="mb-0 mt-1 first:mt-0.5">
              {text}
            </p>
          ))}
          {flag && (
            <p className="mb-0 mt-1 first:mt-0.5">
              Setting key <Code>{flag.setting}</Code>
              {flag.envVar && !isForced && (
                <>
                  , or env <Code>{flag.envVar}=1</Code> for this process
                </>
              )}
              .
            </p>
          )}
        </div>
      </details>
    </div>
  )
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="[font-family:var(--font-mono)] text-[11px] text-[var(--text-primary)]">{children}</code>
}

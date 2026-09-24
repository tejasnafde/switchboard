/**
 * UnifiedProviderPicker - single drop-up popover that consolidates the
 * three previously-separate footer controls into one trigger:
 *
 *   1. Agent-kind selector (Claude Code / Codex / OpenCode)
 *   2. Provider-instance picker (named credential set per kind)
 *   3. Model picker (with provider-prefix grouping + custom input)
 *
 * Layout (t3code-inspired):
 *   ┌─ trigger ─────────────────────────────────┐
 *   │ [accent dot/initials] agent · model       │ ▼
 *   └───────────────────────────────────────────┘
 *
 *   Popover (drop-up):
 *     [Claude Code] [Codex] [OpenCode]      ← agent tabs
 *     ┌──────────┬──────────────────────┐
 *     │ [WK] Work│ [search models]      │
 *     │ [DF] Def │ ───────────────────  │
 *     │ ...      │ Model A              │
 *     │          │ Model B              │
 *     │          │ Custom model id...   │
 *     └──────────┴──────────────────────┘
 *
 * The instance rail collapses (single-column) when the active agent has
 * fewer than 2 enabled instances.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import {
  modelsForAgent,
  type ModelOption,
} from '@shared/models'
import {
  AGENT_TYPES,
  agentLabel,
  agentShortLabel,
  defaultInstanceId,
  type AgentType,
  type ProviderInstance,
} from '@shared/types'
import { providerInstanceInitials } from '@shared/provider-instance-initials'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import { useAgentStore } from '../../stores/agent-store'
import { createTerminalAsync } from '../../services/terminal-registry'
import { emitSessionCreated } from '../../services/session-events'
import { terminalLoginAgentType } from '../../shared/terminal-login'
import { shouldShowInstanceRail } from '../../shared/instance-rail-visibility'
import {
  resolveVisibleLoginInstanceId,
  nextTermInstanceId,
} from '../../shared/terminal-login-account'
import { startTerminalSession } from '../../shared/terminal-login-start'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { filterModels, groupModelsByProvider } from './provider-picker-models'

interface UnifiedProviderPickerProps {
  agentType: AgentType
  onAgentTypeChange: (type: AgentType) => void
  canChangeAgent: boolean
  instanceId: string | undefined
  onInstanceChange: (id: string | undefined) => void
  model: string
  onModelChange: (model: string) => void
  /** Dynamic model list (OpenCode CLI / Claude SDK; overrides static when provided). */
  dynamicModels?: ModelOption[] | null
  /**
   * Model the backend resolved to when the user pinned nothing. Used for the
   * trigger label only, so an unpinned session names its real model instead of
   * the useless "Default" that hid `claude-fable-5` on 2026-07-31.
   */
  resolvedModel?: string
}

const AGENTS = AGENT_TYPES.map((value) => ({ value, label: agentLabel(value) }))

export function UnifiedProviderPicker(props: UnifiedProviderPickerProps) {
  const {
    agentType,
    onAgentTypeChange,
    canChangeAgent,
    instanceId,
    onInstanceChange,
    model,
    onModelChange,
    dynamicModels,
    resolvedModel,
  } = props

  const [open, setOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  // Lifted so Escape can back out of the custom model field before it closes the picker.
  const [showCustom, setShowCustom] = useState(false)

  // Terminal tab state
  const [termCommand, setTermCommand] = useState('claude')
  const [termInstanceId, setTermInstanceId] = useState<string | undefined>(undefined)
  const [termStarting, setTermStarting] = useState(false)
  const [termError, setTermError] = useState<string | null>(null)

  // Key the picked account to the CLI binary's login kind - a Codex
  // instance id must never survive a switch to Claude (or to a custom
  // command), which would otherwise get sent as identity for the wrong
  // kind (see terminal-login-env.ts's wrong-kind rejection).
  const loginAgentType = terminalLoginAgentType(termCommand)
  const prevLoginAgentTypeRef = useRef(loginAgentType)
  useEffect(() => {
    setTermInstanceId((current) => nextTermInstanceId(prevLoginAgentTypeRef.current, loginAgentType, current))
    prevLoginAgentTypeRef.current = loginAgentType
  }, [loginAgentType])

  const allInstances = useProviderInstanceStore((s) => s.instances)
  const loaded = useProviderInstanceStore((s) => s.loaded)
  const refresh = useProviderInstanceStore((s) => s.refresh)

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  const instances = useMemo(() => {
    const def = defaultInstanceId(agentType)
    return allInstances
      .filter((i) => i.agentType === agentType && i.enabled)
      .sort((a, b) => {
        const aDef = a.id === def ? 0 : 1
        const bDef = b.id === def ? 0 : 1
        if (aDef !== bDef) return aDef - bDef
        return a.displayName.localeCompare(b.displayName)
      })
  }, [allInstances, agentType])

  const effectiveInstance = useMemo<ProviderInstance | undefined>(() => {
    const wanted = instanceId ?? defaultInstanceId(agentType)
    return instances.find((i) => i.id === wanted) ?? instances[0]
  }, [instances, instanceId, agentType])

  const staticModels = modelsForAgent(agentType)
  const models = dynamicModels && dynamicModels.length > 0
    ? dynamicModels
    : staticModels

  const accent = effectiveInstance?.accentColor ?? 'var(--accent)'
  const initials = effectiveInstance ? providerInstanceInitials(effectiveInstance.displayName) : '··'
  // Computed from the RAW requested instanceId (not `effectiveInstance.id`,
  // which is already post-fallback and so always a member of `instances`) -
  // this is what lets both the badge and the rail stay visible when that id
  // no longer names an enabled instance (deleted/disabled elsewhere).
  const showRail = shouldShowInstanceRail(instances, instanceId)
  const showInstanceBadge = showRail

  // Trigger label: "Claude · Sonnet 4.5". An unpinned session shows the model
  // the backend resolved to, falling back to "Default" only before the first
  // turn reports one - a bare "Default" hid the model that caused the
  // 2026-07-31 spend rejection.
  const modelLabel = useMemo(() => {
    const effective = model || resolvedModel
    if (!effective) return 'Default'
    const found = models.find((m) => m.id === effective)
    return found?.label ?? effective
  }, [models, model, resolvedModel])


  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setShowCustom(false)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${agentShortLabel(agentType)}${effectiveInstance ? ' · ' + effectiveInstance.displayName : ''} · ${modelLabel}`}
          style={accentVar(accent)}
          className="inline-flex max-w-[280px] cursor-pointer items-center gap-[6px] rounded-[6px] border border-[var(--border)] bg-[var(--bg-tertiary)] py-[3px] pr-[8px] pl-[4px] text-[11px] leading-none text-[var(--text-secondary)] outline-none transition-[border-color] duration-[120ms] ease-[ease] data-[state=open]:border-[var(--pick-accent)]"
        >
          <span
            aria-hidden
            className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--pick-accent)] text-[8px] font-[700] tracking-[0.02em] text-[#fff]"
          >
            {showInstanceBadge ? initials : agentShortLabel(agentType).slice(0, 2).toUpperCase()}
          </span>
          <span className="truncate font-[500] text-[var(--text-primary)]">
            {agentShortLabel(agentType)}
            {showInstanceBadge && effectiveInstance ? ` · ${effectiveInstance.displayName}` : ''}
          </span>
          <span className="whitespace-nowrap text-[var(--text-muted)]">·</span>
          <span className="truncate [font-family:var(--font-mono)] text-[var(--text-secondary)]">
            {modelLabel}
          </span>
          <span className="ml-[2px] text-[9px] text-[var(--text-muted)]">▾</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        aria-label="Provider, instance, and model picker"
        // The model search takes focus, as the old autoFocus did; the terminal
        // tab has no search, so focus stays on the trigger there.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchRef.current?.focus()
        }}
        // Escape leaves the custom model field, or else closes the picker.
        // Either way the chat behind it must not see it.
        onEscapeKeyDown={(e) => {
          e.stopPropagation()
          if (!showCustom) return
          e.preventDefault()
          setShowCustom(false)
          searchRef.current?.focus()
        }}
        className="sb-provider-picker z-[1200] flex max-h-[360px] w-[480px] flex-col overflow-hidden rounded-[8px] border border-[var(--border)]"
      >
        <UnifiedPickerPopover
          searchRef={searchRef}
          showCustom={showCustom}
          setShowCustom={setShowCustom}
          agentType={agentType}
          canChangeAgent={canChangeAgent}
          // Stays open so the user sees the instance/model lists swap.
          onAgentTypeChange={onAgentTypeChange}
          instances={instances}
          effectiveInstanceId={effectiveInstance?.id}
          showRail={showRail}
          onInstanceChange={onInstanceChange}
          model={model}
          models={models}
          onModelChange={(m) => {
            onModelChange(m)
            setOpen(false)
          }}
          allInstances={allInstances}
          termCommand={termCommand}
          setTermCommand={setTermCommand}
          termInstanceId={termInstanceId}
          setTermInstanceId={setTermInstanceId}
          termStarting={termStarting}
          termError={termError}
          onTermStart={() => {
            const active = useAgentStore.getState().getActiveSession()
            const projectPath = active?.projectPath ?? '.'
            const machineId = active?.machineId
            // Identity only - main resolves the instance's real env
            // (CODEX_HOME / CLAUDE_CONFIG_DIR) across the IPC boundary.
            // Building that env here directly missed Codex entirely and
            // let a Codex login terminal silently fall back to whatever
            // ambient/default CODEX_HOME happened to be set.
            const loginInstance = loginAgentType
              ? { agentType: loginAgentType, instanceId: termInstanceId }
              : undefined
            setTermError(null)
            setTermStarting(true)
            // Awaits terminal:create BEFORE creating any session/store/
            // conversation artifact - a rejected create (missing/disabled/
            // wrong-kind instance) must never leave a dead session with no
            // working PTY behind it, and must never surface as an
            // unhandled promise rejection.
            startTerminalSession(
              {
                createTerminal: createTerminalAsync,
                addSession: (session) => useAgentStore.getState().addSession(session),
                setActiveSession: (id) => useAgentStore.getState().setActiveSession(id),
                createConversation: (params) => window.api.app.createConversation(params),
                emitSessionCreated,
              },
              { projectPath, machineId, command: termCommand, loginInstance, instanceId: termInstanceId },
            ).then((result) => {
              setTermStarting(false)
              if (result.ok) {
                setOpen(false)
              } else {
                setTermError(result.error ?? 'Failed to start terminal session.')
              }
            })
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The per-instance accent colour, read by the arbitrary classes below. */
function accentVar(accent: string): CSSProperties {
  return { '--pick-accent': accent } as CSSProperties
}

interface PopoverProps {
  searchRef: RefObject<HTMLInputElement | null>
  showCustom: boolean
  setShowCustom: (show: boolean) => void
  agentType: AgentType
  canChangeAgent: boolean
  onAgentTypeChange: (t: AgentType) => void
  instances: ProviderInstance[]
  effectiveInstanceId: string | undefined
  showRail: boolean
  onInstanceChange: (id: string | undefined) => void
  model: string
  models: ModelOption[]
  onModelChange: (m: string) => void
  // Terminal tab props
  allInstances: ProviderInstance[]
  termCommand: string
  setTermCommand: (c: string) => void
  termInstanceId: string | undefined
  setTermInstanceId: (id: string | undefined) => void
  termStarting: boolean
  termError: string | null
  onTermStart: () => void
}

const inputClass = 'rounded-[4px] border border-[var(--border)] bg-[var(--bg-tertiary)] px-[8px] text-[11px] text-[var(--text-primary)] outline-none'
const sectionLabelClass = 'mb-[6px] text-[10px] font-[600] uppercase tracking-[0.7px] text-[var(--text-muted)]'

function UnifiedPickerPopover(props: PopoverProps) {
  const {
    searchRef, showCustom, setShowCustom, agentType, canChangeAgent, onAgentTypeChange,
    instances, effectiveInstanceId, showRail, onInstanceChange,
    model, models, onModelChange,
    allInstances, termCommand, setTermCommand, termInstanceId, setTermInstanceId,
    termStarting, termError, onTermStart,
  } = props
  const [query, setQuery] = useState('')
  const [customValue, setCustomValue] = useState('')

  // Reset filter / custom-input branch when agent kind flips.
  useEffect(() => {
    setQuery('')
    setShowCustom(false)
    setCustomValue('')
  }, [agentType, setShowCustom])

  const filtered = useMemo(() => filterModels(models, query), [models, query])
  const grouped = useMemo(() => groupModelsByProvider(filtered), [filtered])

  return (
    <>
      {/* Agent tabs */}
      <div className="flex gap-[2px] border-b border-[var(--border)] bg-[var(--bg-tertiary)] p-[6px]">
        {AGENTS.map((a) => {
          const active = a.value === agentType
          const locked = !canChangeAgent && !active
          return (
            <button
              key={a.value}
              type="button"
              disabled={locked}
              onClick={() => onAgentTypeChange(a.value)}
              className={cn(
                'flex-1 rounded-[5px] border px-[8px] py-[5px] text-[11px] outline-none transition-[background,border-color] duration-[120ms] ease-[ease]',
                active
                  ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,var(--bg-secondary))] font-[600] text-[var(--text-primary)]'
                  : 'border-transparent bg-transparent font-[500] text-[var(--text-secondary)]',
                locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              )}
            >
              {a.label}
            </button>
          )
        })}
      </div>

      {/* Terminal tab body */}
      {agentType === 'terminal' && (
        <TerminalTabBody
          allInstances={allInstances}
          termCommand={termCommand}
          setTermCommand={setTermCommand}
          termInstanceId={termInstanceId}
          setTermInstanceId={setTermInstanceId}
          termStarting={termStarting}
          termError={termError}
          onStart={onTermStart}
        />
      )}

      {/* Body - split rail (when 2+ instances) + model list */}
      <div className={cn('min-h-0 flex-1', agentType === 'terminal' ? 'hidden' : 'flex')}>
        {showRail && (
          <div
            role="radiogroup"
            aria-label="Provider instance"
            className="flex w-[132px] flex-col gap-[3px] overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-secondary)] p-[6px]"
          >
            {instances.map((inst) => (
              <InstanceRailItem
                key={inst.id}
                instance={inst}
                active={inst.id === effectiveInstanceId}
                onSelect={() => onInstanceChange(inst.id)}
              />
            ))}
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Search */}
          <div className="border-b border-[var(--border)] p-[6px]">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              onKeyDown={(e) => e.stopPropagation()}
              className={cn(inputClass, 'w-full py-[4px]')}
            />
          </div>

          {/* Model list */}
          <div className="flex-1 overflow-y-auto py-[4px]">
            {!showCustom && (
              <>
                <ModelRow
                  label="Default"
                  monoId=""
                  active={!model}
                  onSelect={() => onModelChange('')}
                />
                {grouped.ungrouped.map((m) => (
                  <ModelRow
                    key={m.id}
                    label={m.label}
                    monoId={m.id}
                    active={m.id === model}
                    onSelect={() => onModelChange(m.id)}
                  />
                ))}
                {grouped.groups.map((g) => (
                  <div key={g.provider}>
                    <div className="px-[12px] pt-[6px] pb-[2px] text-[9px] font-[700] uppercase tracking-[0.06em] text-[var(--text-muted)]">
                      {g.provider}
                    </div>
                    {g.models.map((m) => (
                      <ModelRow
                        key={m.id}
                        label={m.label}
                        monoId={m.id}
                        active={m.id === model}
                        onSelect={() => onModelChange(m.id)}
                      />
                    ))}
                  </div>
                ))}
                {filtered.length === 0 && (
                  <div className="p-[12px] text-center text-[11px] text-[var(--text-muted)]">
                    No matches.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => { setShowCustom(true); setCustomValue(model) }}
                  className="mt-[4px] block w-full cursor-pointer border-x-0 border-b-0 border-t border-[var(--border)] bg-transparent px-[12px] py-[6px] text-left text-[11px] text-[var(--accent)]"
                >
                  Custom model id…
                </button>
              </>
            )}
            {showCustom && (
              <div className="flex flex-col gap-[6px] px-[10px] py-[8px]">
                <input
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') onModelChange(customValue.trim())
                  }}
                  placeholder="provider/model-id"
                  autoFocus
                  className={cn(inputClass, 'py-[5px] [font-family:var(--font-mono)]')}
                />
                <div className="flex justify-end gap-[6px]">
                  <button
                    type="button"
                    onClick={() => setShowCustom(false)}
                    className={pillButtonClass(false)}
                  >Cancel</button>
                  <button
                    type="button"
                    onClick={() => onModelChange(customValue.trim())}
                    disabled={!customValue.trim()}
                    className={pillButtonClass(true)}
                  >Use</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function TerminalTabBody({
  allInstances,
  termCommand,
  setTermCommand,
  termInstanceId,
  setTermInstanceId,
  termStarting,
  termError,
  onStart,
}: {
  allInstances: ProviderInstance[]
  termCommand: string
  setTermCommand: (c: string) => void
  termInstanceId: string | undefined
  setTermInstanceId: (id: string | undefined) => void
  termStarting: boolean
  termError: string | null
  onStart: () => void
}) {
  // Instances for whichever CLI binary is selected - main resolves the
  // picked instance's oauthDir (CLAUDE_CONFIG_DIR / CODEX_HOME) at spawn.
  const loginAgentType = terminalLoginAgentType(termCommand)
  const loginInstances = loginAgentType
    ? allInstances.filter((i) => i.agentType === loginAgentType && i.enabled)
    : []
  const isCustom = loginAgentType === null
  // Mirrors main's resolveProviderInstance fallback order (canonical
  // default, then oldest enabled) so the highlighted row is always the
  // exact instance main will resolve when no explicit pick has been made -
  // never a different account than the one whose credential home is
  // actually in use.
  const visibleInstanceId = loginAgentType
    ? resolveVisibleLoginInstanceId(loginInstances, loginAgentType, termInstanceId)
    : undefined

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* CLI selector */}
      <div className="border-b border-[var(--border)] px-[8px] pt-[8px] pb-[6px]">
        <div className={sectionLabelClass}>CLI Binary</div>
        <div className="flex items-center gap-[4px]">
          {(['claude', 'codex'] as const).map((cmd) => (
            <button
              key={cmd}
              type="button"
              onClick={() => setTermCommand(cmd)}
              className={cn(
                'cursor-pointer rounded-[5px] border px-[12px] py-[4px] text-[11px] [font-family:var(--font-mono)] outline-none transition-[background,border-color] duration-[120ms]',
                termCommand === cmd
                  ? 'border-[var(--warning)] bg-[rgba(210,153,34,0.1)] text-[var(--warning)]'
                  : 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
              )}
            >{cmd}</button>
          ))}
          <input
            value={isCustom ? termCommand : ''}
            onChange={(e) => setTermCommand(e.target.value || 'claude')}
            placeholder="custom path…"
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              'flex-1 rounded-[5px] border bg-[var(--bg-tertiary)] px-[8px] py-[4px] text-[11px] [font-family:var(--font-mono)] text-[var(--text-primary)] outline-none',
              isCustom ? 'border-[var(--border-focus)]' : 'border-[var(--border)]',
            )}
          />
        </div>
      </div>

      {/* Account - shown for claude/codex binaries, not a custom command */}
      {loginAgentType && loginInstances.length > 0 && (
        <div className="max-h-[140px] overflow-y-auto border-b border-[var(--border)] px-[8px] pt-[8px] pb-[6px]">
          <div className={sectionLabelClass}>Account</div>
          {loginInstances.map((inst) => {
            const active = visibleInstanceId === inst.id
            return (
              <button
                key={inst.id}
                type="button"
                onClick={() => setTermInstanceId(inst.id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-[8px] rounded-[5px] border px-[8px] py-[6px] text-left text-[12px] outline-none transition-[background,border-color] duration-[120ms]',
                  active
                    ? 'border-[var(--border-focus)] bg-[var(--bg-active)] text-[var(--text-primary)]'
                    : 'border-transparent bg-transparent text-[var(--text-secondary)]',
                )}
              >
                <span className={cn('size-[6px] shrink-0 rounded-full', active ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]')} />
                <span className="flex-1 truncate">{inst.displayName}</span>
                {inst.id.endsWith('-default') && (
                  <span className="text-[9px] [font-family:var(--font-mono)] text-[var(--text-muted)]">default</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Billing note */}
      <div className="border-b border-[var(--border)] p-[8px]">
        <div className="flex gap-[7px] rounded-[var(--radius)] border border-[rgba(63,185,80,0.15)] bg-[rgba(63,185,80,0.05)] px-[10px] py-[7px] text-[11px] leading-[1.5] text-[var(--text-secondary)]">
          <span className="shrink-0 text-[var(--success)]">●</span>
          Runs <code className="rounded-[3px] bg-[rgba(63,185,80,0.1)] px-[4px] text-[10.5px] [font-family:var(--font-mono)] text-[var(--success)]">{termCommand}</code> directly - billed from your subscription, not API credits.
        </div>
      </div>

      {/* Start-failure error - the terminal:create IPC call rejected (e.g. a
          missing/disabled/wrong-kind login instance) before any PTY spawned.
          Surfaced here instead of silently dropping an unhandled rejection. */}
      {termError && (
        <div className="px-[8px] pb-[8px]">
          <div className="rounded-[var(--radius)] border border-[rgba(248,81,73,0.25)] bg-[rgba(248,81,73,0.08)] px-[10px] py-[7px] text-[11px] leading-[1.5] text-[var(--danger,#f85149)]">
            {termError}
          </div>
        </div>
      )}

      {/* Start button */}
      <div className="flex justify-end p-[8px]">
        <button
          type="button"
          onClick={onStart}
          disabled={termStarting}
          className={cn(
            'rounded-[var(--radius)] border-0 bg-[var(--warning)] px-[14px] py-[6px] text-[12px] font-[600] text-[#000] transition-opacity duration-[120ms]',
            termStarting ? 'cursor-default opacity-60' : 'cursor-pointer',
          )}
        >
          {termStarting ? 'Starting…' : 'Start Terminal Session'}
        </button>
      </div>
    </div>
  )
}

function InstanceRailItem({
  instance,
  active,
  onSelect,
}: {
  instance: ProviderInstance
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={instance.displayName}
      onClick={onSelect}
      style={accentVar(instance.accentColor ?? 'var(--accent)')}
      className={cn(
        'flex cursor-pointer items-center gap-[6px] rounded-[5px] border px-[7px] py-[5px] text-left text-[11px] leading-[1.1] outline-none transition-[background,border-color] duration-[120ms] ease-[ease]',
        active
          ? 'border-[var(--pick-accent)] bg-[color-mix(in_srgb,var(--pick-accent)_22%,var(--bg-secondary))] font-[600] text-[var(--text-primary)]'
          : 'border-transparent bg-transparent font-[500] text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--pick-accent)_10%,var(--bg-secondary))]',
      )}
    >
      <span
        aria-hidden
        className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--pick-accent)] text-[8px] font-[700] text-[#fff]"
      >
        {providerInstanceInitials(instance.displayName)}
      </span>
      <span className="truncate">{instance.displayName}</span>
    </button>
  )
}

function ModelRow({
  label,
  monoId,
  active,
  onSelect,
}: {
  label: string
  monoId: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full cursor-pointer items-baseline justify-between gap-[8px] border-0 px-[12px] py-[5px] text-left text-[11px] outline-none',
        active
          ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] font-[600] text-[var(--text-primary)]'
          : 'bg-transparent font-[500] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]',
      )}
    >
      <span className="truncate">{label}</span>
      {monoId && (
        <span className="max-w-[50%] truncate text-[10px] [font-family:var(--font-mono)] text-[var(--text-muted)]">{monoId}</span>
      )}
    </button>
  )
}

function pillButtonClass(primary: boolean): string {
  return cn(
    'cursor-pointer rounded-[4px] border px-[10px] py-[4px] text-[11px] font-[600] outline-none',
    primary
      ? 'border-[var(--accent)] bg-[var(--accent)] text-[#fff]'
      : 'border-[var(--border)] bg-transparent text-[var(--text-secondary)]',
  )
}

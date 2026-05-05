/**
 * UnifiedProviderPicker — single drop-up popover that consolidates the
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
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  modelsForAgent,
  type ModelOption,
} from '@shared/models'
import {
  defaultInstanceId,
  type AgentType,
  type ProviderInstance,
} from '@shared/types'
import { providerInstanceInitials } from '@shared/providerInstanceInitials'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'

interface UnifiedProviderPickerProps {
  agentType: AgentType
  onAgentTypeChange: (type: AgentType) => void
  canChangeAgent: boolean
  instanceId: string | undefined
  onInstanceChange: (id: string | undefined) => void
  model: string
  onModelChange: (model: string) => void
  /** Dynamic OpenCode model list (overrides static when provided). */
  dynamicModels?: ModelOption[] | null
}

const AGENTS: Array<{ value: AgentType; label: string }> = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
]

const AGENT_SHORT: Record<AgentType, string> = {
  'claude-code': 'Claude',
  'codex': 'Codex',
  'opencode': 'OpenCode',
}

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
  } = props

  const [open, setOpen] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

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
  const models = agentType === 'opencode' && dynamicModels && dynamicModels.length > 0
    ? dynamicModels
    : staticModels

  // Close on outside click + Escape
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // Track anchor rect so the portal-rendered popover repositions on
  // scroll/resize (the ChatInput container can scroll when image previews
  // grow it).
  useEffect(() => {
    if (!open) return
    const update = () => {
      if (triggerRef.current) {
        setAnchorRect(triggerRef.current.getBoundingClientRect())
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  const accent = effectiveInstance?.accentColor ?? 'var(--accent)'
  const initials = effectiveInstance ? providerInstanceInitials(effectiveInstance.displayName) : '··'
  const showInstanceBadge = instances.length >= 2

  // Trigger label: "Claude · Sonnet 4.5" (or just "Claude · Default" when no model).
  const modelLabel = useMemo(() => {
    if (!model) return 'Default'
    const found = models.find((m) => m.id === model)
    return found?.label ?? model
  }, [models, model])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`${AGENT_SHORT[agentType]}${effectiveInstance ? ' · ' + effectiveInstance.displayName : ''} · ${modelLabel}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          background: 'var(--bg-tertiary)',
          color: 'var(--text-secondary)',
          border: `1px solid ${open ? accent : 'var(--border)'}`,
          borderRadius: '6px',
          padding: '3px 8px 3px 4px',
          fontSize: '11px',
          cursor: 'pointer',
          outline: 'none',
          maxWidth: '280px',
          lineHeight: 1,
          transition: 'border-color 120ms ease',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: accent,
            color: '#fff',
            fontSize: '8px',
            fontWeight: 700,
            letterSpacing: '0.02em',
            flexShrink: 0,
          }}
        >
          {showInstanceBadge ? initials : AGENT_SHORT[agentType].slice(0, 2).toUpperCase()}
        </span>
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          {AGENT_SHORT[agentType]}
          {showInstanceBadge && effectiveInstance ? ` · ${effectiveInstance.displayName}` : ''}
        </span>
        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>·</span>
        <span
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
          }}
        >
          {modelLabel}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: '9px', marginLeft: '2px' }}>▾</span>
      </button>

      {open && anchorRect && createPortal(
        <UnifiedPickerPopover
          ref={popoverRef}
          anchorRect={anchorRect}
          agentType={agentType}
          canChangeAgent={canChangeAgent}
          onAgentTypeChange={(t) => {
            onAgentTypeChange(t)
            // Don't close — let the user see the instance/model lists swap.
          }}
          instances={instances}
          effectiveInstanceId={effectiveInstance?.id}
          onInstanceChange={(id) => {
            onInstanceChange(id)
          }}
          model={model}
          models={models}
          onModelChange={(m) => {
            onModelChange(m)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />,
        document.body,
      )}
    </>
  )
}

interface PopoverProps {
  anchorRect: DOMRect
  agentType: AgentType
  canChangeAgent: boolean
  onAgentTypeChange: (t: AgentType) => void
  instances: ProviderInstance[]
  effectiveInstanceId: string | undefined
  onInstanceChange: (id: string | undefined) => void
  model: string
  models: ModelOption[]
  onModelChange: (m: string) => void
  onClose: () => void
}

const UnifiedPickerPopover = (() => {
  // forwardRef without importing — keeps the component definition flat.
  return function Inner(props: PopoverProps & { ref?: React.Ref<HTMLDivElement> }) {
    const {
      anchorRect, agentType, canChangeAgent, onAgentTypeChange,
      instances, effectiveInstanceId, onInstanceChange,
      model, models, onModelChange,
    } = props
    const [query, setQuery] = useState('')
    const [showCustom, setShowCustom] = useState(false)
    const [customValue, setCustomValue] = useState('')

    // Reset filter / custom-input branch when agent kind flips.
    useEffect(() => {
      setQuery('')
      setShowCustom(false)
      setCustomValue('')
    }, [agentType])

    // Translucent theme makes `var(--bg-elevated)` undefined and the
    // other surfaces near-transparent — that's wallpaper-on-wallpaper for
    // the popover. Detect the theme class once and pick a solid-enough
    // background per palette; light-mode keeps near-white, dark/translucent
    // get a near-black surface. Blur layered on top adds the glass feel.
    const popoverBg = useMemo(() => {
      const cls = document.body.classList
      if (cls.contains('theme-light')) return 'rgba(255, 255, 255, 0.96)'
      // dark + translucent both get a deep panel
      return 'rgba(22, 22, 26, 0.94)'
    }, [])

    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase()
      if (!q) return models
      return models.filter((m) =>
        m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q),
      )
    }, [models, query])

    // Group by provider prefix (id before first `/`)
    const grouped = useMemo(() => {
      const ungrouped: ModelOption[] = []
      const groupMap = new Map<string, ModelOption[]>()
      const order: string[] = []
      for (const m of filtered) {
        const slash = m.id.indexOf('/')
        if (slash === -1) {
          ungrouped.push(m)
          continue
        }
        const provider = m.id.slice(0, slash)
        if (!groupMap.has(provider)) { groupMap.set(provider, []); order.push(provider) }
        groupMap.get(provider)!.push(m)
      }
      return { ungrouped, groups: order.map((p) => ({ provider: p, models: groupMap.get(p)! })) }
    }, [filtered])

    // Position: drop-UP. Anchor the popover's BOTTOM 6px above the
    // trigger's top — this way the gap stays constant regardless of how
    // tall the popover content actually is (using `top: anchor - max-h`
    // floats the popover way above the trigger when content is short).
    const POPOVER_WIDTH = 480
    const POPOVER_MAX_H = 360
    const bottom = Math.max(8, window.innerHeight - anchorRect.top + 6)
    const left = Math.min(
      Math.max(8, anchorRect.left),
      window.innerWidth - POPOVER_WIDTH - 8,
    )

    const showRail = instances.length >= 2

    return (
      <div
        ref={props.ref}
        role="dialog"
        aria-label="Provider, instance, and model picker"
        style={{
          position: 'fixed',
          bottom,
          left,
          width: POPOVER_WIDTH,
          maxHeight: POPOVER_MAX_H,
          // Use the theme's elevated surface (solid in dark/light, mostly
          // solid in translucent) and layer a blur so the wallpaper still
          // bleeds through subtly without hurting legibility.
          background: popoverBg,
          backdropFilter: 'blur(24px) saturate(150%)',
          WebkitBackdropFilter: 'blur(24px) saturate(150%)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
          zIndex: 1200,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Agent tabs */}
        <div style={{
          display: 'flex',
          gap: '2px',
          padding: '6px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-tertiary)',
        }}>
          {AGENTS.map((a) => {
            const active = a.value === agentType
            return (
              <button
                key={a.value}
                type="button"
                disabled={!canChangeAgent && !active}
                onClick={() => onAgentTypeChange(a.value)}
                style={{
                  flex: 1,
                  padding: '5px 8px',
                  borderRadius: '5px',
                  border: '1px solid ' + (active ? 'var(--accent)' : 'transparent'),
                  background: active ? 'color-mix(in srgb, var(--accent) 16%, var(--bg-secondary))' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontSize: '11px',
                  fontWeight: active ? 600 : 500,
                  cursor: canChangeAgent || active ? 'pointer' : 'not-allowed',
                  opacity: !canChangeAgent && !active ? 0.5 : 1,
                  outline: 'none',
                  transition: 'background 120ms ease, border-color 120ms ease',
                }}
              >
                {a.label}
              </button>
            )
          })}
        </div>

        {/* Body — split rail (when 2+ instances) + model list */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {showRail && (
            <div
              role="radiogroup"
              aria-label="Provider instance"
              style={{
                width: 132,
                borderRight: '1px solid var(--border)',
                padding: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '3px',
                overflowY: 'auto',
                background: 'var(--bg-secondary)',
              }}
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

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {/* Search */}
            <div style={{ padding: '6px', borderBottom: '1px solid var(--border)' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models..."
                autoFocus
                onKeyDown={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  padding: '4px 8px',
                  fontSize: '11px',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Model list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
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
                      <div style={{
                        padding: '6px 12px 2px',
                        fontSize: '9px',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        color: 'var(--text-muted)',
                      }}>
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
                    <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
                      No matches.
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => { setShowCustom(true); setCustomValue(model) }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 12px',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--accent)',
                      fontSize: '11px',
                      cursor: 'pointer',
                      borderTop: '1px solid var(--border)',
                      marginTop: '4px',
                    }}
                  >
                    Custom model id…
                  </button>
                </>
              )}
              {showCustom && (
                <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <input
                    value={customValue}
                    onChange={(e) => setCustomValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        onModelChange(customValue.trim())
                      } else if (e.key === 'Escape') {
                        setShowCustom(false)
                      }
                    }}
                    placeholder="provider/model-id"
                    autoFocus
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      padding: '5px 8px',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      outline: 'none',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => setShowCustom(false)}
                      style={pillBtn(false)}
                    >Cancel</button>
                    <button
                      type="button"
                      onClick={() => onModelChange(customValue.trim())}
                      disabled={!customValue.trim()}
                      style={pillBtn(true)}
                    >Use</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }
})()

function InstanceRailItem({
  instance,
  active,
  onSelect,
}: {
  instance: ProviderInstance
  active: boolean
  onSelect: () => void
}) {
  const [hover, setHover] = useState(false)
  const accent = instance.accentColor ?? 'var(--accent)'
  const bg = active
    ? `color-mix(in srgb, ${accent} 22%, var(--bg-secondary))`
    : (hover ? `color-mix(in srgb, ${accent} 10%, var(--bg-secondary))` : 'transparent')
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={instance.displayName}
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 7px',
        borderRadius: '5px',
        border: `1px solid ${active ? accent : 'transparent'}`,
        background: bg,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: '11px',
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        textAlign: 'left',
        outline: 'none',
        lineHeight: 1.1,
        transition: 'background 120ms ease, border-color 120ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: accent,
          color: '#fff',
          fontSize: '8px',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {providerInstanceInitials(instance.displayName)}
      </span>
      <span style={{
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>{instance.displayName}</span>
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
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        width: '100%',
        padding: '5px 12px',
        background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)'
          : (hover ? 'var(--bg-tertiary)' : 'transparent'),
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        outline: 'none',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: '11px',
        fontWeight: active ? 600 : 500,
        gap: '8px',
      }}
    >
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {monoId && (
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          color: 'var(--text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '50%',
        }}>{monoId}</span>
      )}
    </button>
  )
}

function pillBtn(primary: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: '4px',
    border: '1px solid ' + (primary ? 'var(--accent)' : 'var(--border)'),
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? '#fff' : 'var(--text-secondary)',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  }
}

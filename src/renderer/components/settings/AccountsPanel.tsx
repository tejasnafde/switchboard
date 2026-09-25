/**
 * Accounts & models: one card per provider instance, grouped by agent and
 * sorted by the room left, under a summary strip. Every action sits in the
 * card's ⋯ menu; the editor dialog below is the add and edit flow.
 */

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import type { ProviderInstance } from '@shared/types'
import type { ProviderUsage, UsageWindow } from '@shared/provider-usage'
import { fmtResetsAt } from '@shared/provider-usage'
import { agentLabel, defaultInstanceId } from '@shared/types'
import { providerInstanceInitials } from '@shared/provider-instance-initials'
import {
  oauthCreateDirCommand,
  oauthEnvName,
  oauthLoginCommand,
  suggestedOauthDir,
} from '@shared/provider-auth-format'
import { defaultInstanceSettingKey, defaultModelSettingKey, SETTING_DEFAULT_INSTANCE_ID } from '@shared/session-defaults'
import { defaultModelFor, modelsForAgent } from '@shared/models'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import type { ProviderInstanceUpsertInput } from '../../../preload'
import {
  credentialHomeDisplay,
  defaultAuthModeForNewInstance,
} from '../../shared/provider-instance-display'
import type { AgentProvider } from '@shared/types'
import { AGENT_PROVIDERS } from '@shared/types'
import { confirm } from '../ui/confirm'
import { onEscapeFirst } from '../ui/escape-first'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '../../lib/utils'
import { createRendererLogger } from '../../logger'
import { SETTING_ROW, type SettingRowDef } from './settings-rows'
import {
  accountsSummary,
  barTone,
  credentialSummary,
  defaultAccountId,
  needsAttention,
  sortByRoomLeft,
  untilReset,
  type BarTone,
  type SummaryCell,
} from './accounts-model'

const log = createRendererLogger('settings:accounts')

const DEFAULT_ACCENT_PALETTE = [
  '#ff8a3d',
  '#3da8ff',
  '#7c5cff',
  '#3dd17a',
  '#ff5ca8',
  '#ffd23d',
]

const TONE_COLOR: Record<BarTone, string> = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--error)',
}

const SETTING_KEYS = [
  SETTING_DEFAULT_INSTANCE_ID,
  ...AGENT_PROVIDERS.flatMap((kind) => [defaultInstanceSettingKey(kind), defaultModelSettingKey(kind)]),
]

type LoadUsage = (id: string, opts?: { force?: boolean; refreshWithTurn?: boolean }) => Promise<void>

function isDefault(inst: ProviderInstance): boolean {
  return inst.id === defaultInstanceId(inst.agentType)
}

export function AccountsPanel({ Anchor }: { Anchor: ComponentType<{ def: SettingRowDef; children: ReactNode }> }) {
  const refresh = useProviderInstanceStore((s) => s.refresh)
  const error = useProviderInstanceStore((s) => s.error)
  const clearError = useProviderInstanceStore((s) => s.clearError)
  const instances = useProviderInstanceStore((s) => s.instances)
  const fetchUsage = useProviderInstanceStore((s) => s.usage)
  const [editing, setEditing] = useState<ProviderInstance | null>(null)
  const [adding, setAdding] = useState<AgentProvider | null>(null)
  const [usages, setUsages] = useState<Record<string, ProviderUsage>>({})
  const [stored, setStored] = useState<Record<string, string>>({})

  // Usage probes can take seconds; the page may close first. The effect body
  // re-arms the flag because StrictMode runs mount, cleanup, mount.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Always re-list: another client or the composer may have changed them.
  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    Promise.all(SETTING_KEYS.map((key) => window.api.settings.get(key)))
      .then((values) => {
        if (!mounted.current) return
        const read = Object.fromEntries(SETTING_KEYS.flatMap((key, i) => (values[i] ? [[key, values[i]]] : [])))
        // A pick made before the read landed wins.
        setStored((prev) => ({ ...read, ...prev }))
      })
      .catch((err) => log.warn('reading the account defaults failed', err))
  }, [])

  const writeSetting = useCallback((key: string, value: string) => {
    setStored((prev) => ({ ...prev, [key]: value }))
    window.api.settings.set(key, value).catch((err: unknown) => log.warn(`writing ${key} failed`, err))
  }, [])

  const loadUsage = useCallback<LoadUsage>(async (id, opts) => {
    const usage = await fetchUsage(id, opts)
    if (mounted.current) setUsages((prev) => ({ ...prev, [id]: usage }))
  }, [fetchUsage])

  const enabled = instances.filter((i) => i.enabled)

  // One read per account on open and after each edit (main drops its cached
  // reading on save). Main caches for 45s, so reopening the page is free.
  const requested = useRef(new Set<string>())
  const versions = enabled.map((i) => `${i.id}@${i.updatedAt}`).join(' ')
  useEffect(() => {
    for (const inst of useProviderInstanceStore.getState().instances) {
      const version = `${inst.id}@${inst.updatedAt}`
      if (!inst.enabled || requested.current.has(version)) continue
      requested.current.add(version)
      void loadUsage(inst.id)
    }
  }, [versions, loadUsage])

  const summary = accountsSummary(enabled, usages, Date.now())

  return (
    <div>
      <Anchor def={SETTING_ROW.accountsSummary}>
        <div className="mb-[14px] grid grid-cols-3 gap-[10px]">
          <SummaryTile title="Most room left" cell={summary.mostRoom} />
          <SummaryTile title="Next reset" cell={summary.nextReset} />
          <SummaryTile title="Needs attention" cell={summary.attention} alarm={summary.attention.count > 0} />
        </div>
      </Anchor>

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-start gap-[10px] rounded-[6px] border border-[var(--error)] px-[10px] py-2 text-[12px]"
        >
          <span className="flex-1 leading-[1.5]">{error}</span>
          <Button variant="outline" size="sm" onClick={clearError}>Dismiss</Button>
        </div>
      )}

      <Anchor def={SETTING_ROW.providers}>
        {AGENT_PROVIDERS.map((kind) => {
          const group = sortByRoomLeft(enabled.filter((i) => i.agentType === kind), usages)
          const starred = defaultAccountId(kind, instances, {
            scoped: stored[defaultInstanceSettingKey(kind)],
            legacy: stored[SETTING_DEFAULT_INSTANCE_ID],
          })
          const modelKey = defaultModelSettingKey(kind)
          const model = stored[modelKey] ?? defaultModelFor(kind)
          return (
            <section key={kind} className="mb-[18px]">
              <h3 className="mb-2 text-[11px] font-[600] uppercase tracking-[0.07em] text-[var(--text-muted)]">{agentLabel(kind)}</h3>
              {group.map((inst) => (
                <AccountCard
                  key={inst.id}
                  instance={inst}
                  usage={usages[inst.id]}
                  starred={inst.id === starred}
                  model={model}
                  onSetDefault={() => writeSetting(defaultInstanceSettingKey(kind), inst.id)}
                  onSetModel={(id) => writeSetting(modelKey, id)}
                  onEdit={() => setEditing(inst)}
                  loadUsage={loadUsage}
                />
              ))}
              {group.length === 0 && <div className="text-[12px] text-[var(--text-muted)]">No accounts yet.</div>}
            </section>
          )
        })}
      </Anchor>

      <Anchor def={SETTING_ROW.addAccount}>
        <AddAccountButton onPick={setAdding} />
      </Anchor>

      {editing && (
        <ProviderInstanceDialog
          instance={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <ProviderInstanceDialog
          agentType={adding}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  )
}

function SummaryTile({ title, cell, alarm = false }: { title: string; cell: SummaryCell; alarm?: boolean }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-[10px]">
      <div className="text-[11.5px] text-[var(--text-secondary)]">{title}</div>
      <div className={cn('truncate text-[18px] font-[600] tabular-nums', alarm && 'text-[var(--error)]')}>{cell.value}</div>
      <div className="truncate text-[11.5px] text-[var(--text-secondary)]" title={cell.detail}>{cell.detail}</div>
    </div>
  )
}

const menuItemClass = 'flex w-full cursor-pointer items-center justify-between rounded-[5px] border-0 bg-transparent px-2 py-[5px] text-left text-[12.5px] text-[var(--text-primary)] outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]'
const menuSurfaceClass = 'sb-floating-surface z-[1200] w-[230px] rounded-[8px] border border-[var(--border)] p-1 shadow-[0_12px_30px_rgba(0,0,0,0.45)]!'

function AddAccountButton({ onPick }: { onPick: (kind: AgentProvider) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">+ Add account</Button>
      </PopoverTrigger>
      <PopoverContent align="start" className={menuSurfaceClass}>
        {AGENT_PROVIDERS.map((kind) => (
          <button key={kind} type="button" className={menuItemClass} onClick={() => { setOpen(false); onPick(kind) }}>
            {agentLabel(kind)}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

function AccountCard({
  instance,
  usage,
  starred,
  model,
  onSetDefault,
  onSetModel,
  onEdit,
  loadUsage,
}: {
  instance: ProviderInstance
  usage: ProviderUsage | undefined
  starred: boolean
  model: string
  onSetDefault: () => void
  onSetModel: (id: string) => void
  onEdit: () => void
  loadUsage: LoadUsage
}) {
  const remove = useProviderInstanceStore((s) => s.remove)
  const test = useProviderInstanceStore((s) => s.test)
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    try {
      await task()
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const handleTest = () => run('Testing the sign-in…', async () => {
    setNote(null)
    const result = await test(instance.id)
    if (mounted.current) setNote(result)
  })

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNote({ ok: true, message: done })
    } catch (err) {
      log.warn('clipboard write failed', err)
      setNote({ ok: false, message: `Copy failed: ${text}` })
    }
  }

  function signInAgain() {
    const command = usage?.command || oauthLoginCommand(instance.agentType, instance.effectiveOauthDir ?? '')
    if (!command) {
      onEdit()
      return
    }
    void copy(command, `Copied "${command}". Run it in a terminal, then test the sign-in.`)
  }

  async function handleDelete() {
    if (await confirm({ title: `Delete "${instance.displayName}"?`, body: 'Its saved credentials are removed from Switchboard.', confirmLabel: 'Delete', destructive: true })) {
      remove(instance.id).catch((err: unknown) => log.warn('delete failed', err))
    }
  }

  const home = credentialHomeDisplay(instance.effectiveOauthDir, instance.effectiveOauthDirSource)
  const modelLabel = modelsForAgent(instance.agentType).find((m) => m.id === model)?.label ?? model
  const signedOut = usage?.status === 'unauthenticated'
  const failed = needsAttention(usage) && !signedOut
  const windows = usage?.status === 'ok' ? usage.windows : []
  const overage = usage?.status === 'ok' ? usage.overage.filter((o) => o.enabled) : []
  const muted = signedOut || failed ? null : usage === undefined ? 'Loading usage…' : usage.status === 'ok' ? null : usage.message
  const identity = [usage?.plan && `Plan: ${usage.plan}`, usage?.account].filter(Boolean).join(' · ')

  return (
    <div
      data-account={instance.id}
      className="mb-2 rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)] px-[14px] py-3"
    >
      <div className="flex items-center gap-[10px]">
        <span
          aria-hidden="true"
          className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] text-[11px] font-[700] text-white"
          style={{ background: instance.accentColor ?? 'var(--accent)' }}
        >
          {providerInstanceInitials(instance.displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-[500]" title={identity || undefined}>
            {instance.displayName}
            {starred && <span title="Default account" aria-label="Default account" className="ml-1 text-[12px] text-[var(--warning)]">★</span>}
          </div>
          <div className="truncate text-[12px] text-[var(--text-secondary)]">
            {signedOut ? (
              <><span className="text-[var(--error)]">Signed out</span>{usage?.message && ` · ${usage.message}`}</>
            ) : failed ? (
              <span className="text-[var(--error)]">{usage?.message ?? 'Usage could not be read'}</span>
            ) : (
              <>
                {modelLabel} · <span data-credential>{credentialSummary(instance)}</span>
                {home.warning && !isDefault(instance) && <span className="text-[var(--warning)]"> · {home.warning}</span>}
              </>
            )}
          </div>
        </div>
        {signedOut && <Button size="sm" onClick={signInAgain}>Sign in again</Button>}
        <AccountMenu
          instance={instance}
          starred={starred}
          model={model}
          onSetDefault={onSetDefault}
          onSetModel={onSetModel}
          onEdit={onEdit}
          onTest={() => void handleTest()}
          onRefresh={() => void run('Refreshing usage…', () => loadUsage(instance.id, { force: true }))}
          onCopyFolder={instance.effectiveOauthDir ? () => void copy(instance.effectiveOauthDir!, `Copied ${instance.effectiveOauthDir}.`) : null}
          onDelete={isDefault(instance) ? null : () => void handleDelete()}
        />
      </div>

      {windows.length > 0 && (
        <div className="mt-[10px] grid grid-cols-2 gap-[14px]">
          {windows.map((w) => <UsageMeter key={w.id} window={w} />)}
        </div>
      )}
      {overage.map((o) => (
        <div key={o.id} className="mt-2 text-[12px] text-[var(--text-secondary)]">
          {[o.label, o.usedPercent !== null && `${Math.round(o.usedPercent)}%`, o.detail, o.blockedReason?.replace(/_/g, ' ')].filter(Boolean).join(' · ')}
        </div>
      ))}
      {muted && <div className="mt-2 text-[12px] text-[var(--text-muted)]">{muted}</div>}
      {usage?.status === 'refresh-pending' && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy !== null}
          onClick={() => void run('Refreshing usage…', () => loadUsage(instance.id, { refreshWithTurn: true }))}
        >
          Refresh now
        </Button>
      )}
      {(busy || note) && (
        <div className={cn('mt-2 break-words text-[12px]', !busy && note && !note.ok ? 'text-[var(--error)]' : 'text-[var(--text-muted)]')}>
          {busy ?? note?.message}
        </div>
      )}
    </div>
  )
}

function UsageMeter({ window: w }: { window: UsageWindow }) {
  const tone = barTone(w)
  const reset = untilReset(w.resetsAtMs, Date.now())
  return (
    <div>
      <div className="flex justify-between gap-2 text-[12px] tabular-nums">
        <span>{w.label} · {w.usedPercent === null ? '-' : `${Math.round(w.usedPercent)}%`}</span>
        {reset && (
          <span title={fmtResetsAt(w.resetsAtMs)} style={{ color: tone === 'ok' ? 'var(--text-secondary)' : TONE_COLOR[tone] }}>
            resets {reset}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={w.label}
        aria-valuenow={w.usedPercent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-[5px] h-[7px] overflow-hidden rounded-[4px] bg-[var(--bg-tertiary)]"
      >
        <div className="h-full rounded-[4px]" style={{ width: `${w.usedPercent ?? 0}%`, background: TONE_COLOR[tone] }} />
      </div>
    </div>
  )
}

function AccountMenu({
  instance,
  starred,
  model,
  onSetDefault,
  onSetModel,
  onEdit,
  onTest,
  onRefresh,
  onCopyFolder,
  onDelete,
}: {
  instance: ProviderInstance
  starred: boolean
  model: string
  onSetDefault: () => void
  onSetModel: (id: string) => void
  onEdit: () => void
  onTest: () => void
  onRefresh: () => void
  onCopyFolder: (() => void) | null
  onDelete: (() => void) | null
}) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState(false)
  const pick = (action: () => void) => () => { setOpen(false); action() }
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); setModels(false) }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon-xs" className="size-[26px] font-[400] text-[var(--text-secondary)]" aria-label={`Actions for ${instance.displayName}`}>⋯</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className={menuSurfaceClass}>
        {models ? (
          <>
            <button type="button" className={cn(menuItemClass, 'text-[var(--text-secondary)]')} onClick={() => setModels(false)}>
              ‹ Default model for new {agentLabel(instance.agentType)} chats
            </button>
            {modelsForAgent(instance.agentType).map((m) => (
              <button key={m.id} type="button" className={menuItemClass} aria-pressed={m.id === model} onClick={pick(() => onSetModel(m.id))}>
                {m.label}
                {m.id === model && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </>
        ) : (
          <>
            {!starred && <button type="button" className={menuItemClass} onClick={pick(onSetDefault)}>Set as default</button>}
            <button type="button" className={menuItemClass} onClick={() => setModels(true)}>Default model <span aria-hidden="true">›</span></button>
            <button type="button" className={menuItemClass} onClick={pick(onEdit)}>Rename or edit…</button>
            <button type="button" className={menuItemClass} onClick={pick(onTest)}>Test the sign-in</button>
            <button type="button" className={menuItemClass} onClick={pick(onRefresh)}>Refresh usage</button>
            {onCopyFolder && <button type="button" className={menuItemClass} onClick={pick(onCopyFolder)}>Copy the folder path</button>}
            {onDelete && <button type="button" className={cn(menuItemClass, 'text-[var(--error)]')} onClick={pick(onDelete)}>Delete</button>}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

function ProviderInstanceDialog({
  instance,
  agentType,
  onClose,
}: {
  instance?: ProviderInstance
  agentType?: AgentProvider
  onClose: () => void
}) {
  const upsert = useProviderInstanceStore((s) => s.upsert)
  const kind = instance?.agentType ?? agentType!
  const [displayName, setDisplayName] = useState(instance?.displayName ?? '')
  const [accentColor, setAccentColor] = useState<string>(
    instance?.accentColor ?? DEFAULT_ACCENT_PALETTE[0],
  )
  const [authMode, setAuthMode] = useState<'env' | 'oauth_dir'>(
    instance?.authMode ?? defaultAuthModeForNewInstance(kind),
  )
  const [oauthDir, setOauthDir] = useState(instance?.oauthDir ?? '')
  // Prefill only while the user hasn't typed their own path - never
  // auto-repoint an existing row's dir, and stop reacting the moment the
  // user edits the field themselves.
  const [oauthDirTouched, setOauthDirTouched] = useState(false)
  // Env: existing keys are surfaced (values empty - main never re-sends).
  // Only filled-in rows are sent, so a key left blank is DROPPED from the
  // stored overlay. The one exception is the structural credential home
  // (CODEX_HOME/CLAUDE_CONFIG_DIR): main carries that forward across a save
  // that omits it, because it is the profile's account identity and losing it
  // would silently move the profile onto the shared default account. See
  // `envToStore` in main/db/provider-instances.ts - the invariant lives there,
  // not here, so it holds for every caller.
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>(() => {
    if (instance && instance.envKeys.length > 0) {
      return instance.envKeys.map((k) => ({ key: k, value: '' }))
    }
    return [{ key: '', value: '' }]
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [oauthStatus, setOauthStatus] = useState<string | null>(null)

  const isDefaultRow = !!instance && isDefault(instance)
  const supportsOauthDir = kind === 'claude-code' || kind === 'codex'
  const suggestedDir = suggestedOauthDir(kind, displayName || instance?.displayName || 'work')
  const effectiveOauthDir = oauthDir.trim() || suggestedDir
  const loginCommand = oauthLoginCommand(kind, effectiveOauthDir)
  const createCommand = oauthCreateDirCommand(effectiveOauthDir)
  const oauthEnv = oauthEnvName(kind)

  // New Codex instances default to oauth_dir mode (set above) and get a
  // unique-enough slug-based home prefilled from the display name as soon
  // as one is typed - Save still blocks on a blank/duplicate dir via the
  // backend, this only spares the common case of forgetting to set one.
  // Never runs for an existing row: editing must never auto-repoint a
  // saved instance's credential home.
  // Escape closes this editor, not the Settings dialog it sits in.
  useEffect(() => onEscapeFirst(onClose), [onClose])

  useEffect(() => {
    if (instance) return
    if (oauthDirTouched) return
    if (authMode !== 'oauth_dir') return
    setOauthDir(suggestedOauthDir(kind, displayName))
  }, [instance, oauthDirTouched, authMode, kind, displayName])

  async function copyText(text: string, label: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setOauthStatus(`${label} copied.`)
    } catch (err) {
      log.warn('clipboard write failed', err)
      setOauthStatus(`Copy failed. ${label}: ${text}`)
    }
  }

  async function handleCreateOauthDir() {
    setOauthStatus(null)
    const result = await window.api.providerInstances.createOauthDir(effectiveOauthDir)
    if (result.ok) {
      if (!oauthDir.trim()) setOauthDir(effectiveOauthDir)
      setOauthStatus(`Created ${result.path ?? effectiveOauthDir}.`)
    } else {
      setOauthStatus(result.error ?? 'Failed to create OAuth directory.')
    }
  }

  async function handleSave() {
    if (!displayName.trim()) {
      setError('Display name required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      // Build env map; drop rows with empty key. Empty value = don't set.
      const env: Record<string, string> = {}
      for (const row of envRows) {
        const k = row.key.trim()
        if (!k) continue
        if (row.value.length > 0) env[k] = row.value
      }
      const input: ProviderInstanceUpsertInput = {
        id: instance?.id,
        agentType: kind as AgentProvider,
        displayName: displayName.trim(),
        accentColor,
        authMode,
        env: authMode === 'env' ? env : null,
        oauthDir: authMode === 'oauth_dir' ? oauthDir.trim() || null : null,
        enabled: instance?.enabled ?? true,
      }
      await upsert(input)
      onClose()
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '480px',
          maxHeight: '80vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '18px 20px',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '14px' }}>
          {instance ? `Edit account - ${agentLabel(kind)}` : `New account - ${agentLabel(kind)}`}
        </div>

        <Field label="Display name">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={isDefaultRow}
            placeholder="e.g. Work, Personal"
            style={inputStyle}
          />
        </Field>

        <Field label="Accent color">
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {DEFAULT_ACCENT_PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => setAccentColor(c)}
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  background: c,
                  border: accentColor === c ? '2px solid var(--text-primary)' : '2px solid transparent',
                  cursor: 'pointer',
                }}
                aria-label={`Pick ${c}`}
              />
            ))}
          </div>
        </Field>

        {supportsOauthDir && (
          <Field label="Auth mode">
            <div style={{ display: 'flex', gap: '8px' }}>
              <ModeButton active={authMode === 'env'} onClick={() => setAuthMode('env')}>
                API key (env)
              </ModeButton>
              <ModeButton active={authMode === 'oauth_dir'} onClick={() => setAuthMode('oauth_dir')}>
                OAuth dir
              </ModeButton>
            </div>
          </Field>
        )}

        {authMode === 'oauth_dir' ? (
          <Field
            label={oauthEnv ?? 'OAuth directory'}
            hint={
              kind === 'claude-code'
                ? 'Create one directory per Claude account, run the login command in a terminal, then save and test.'
                : 'Create one CODEX_HOME per Codex account, run the login command in a terminal, then save and test.'
            }
          >
            <input
              type="text"
              value={oauthDir}
              onChange={(e) => {
                setOauthDirTouched(true)
                setOauthDir(e.target.value)
              }}
              placeholder={suggestedDir}
              style={inputStyle}
            />
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
              <button
                onClick={() => {
                  setOauthDir(suggestedDir)
                  setOauthStatus(`Using ${suggestedDir}.`)
                }}
                style={smallButtonStyle}
              >
                Use suggested dir
              </button>
              <button onClick={handleCreateOauthDir} style={smallButtonStyle}>
                Create dir
              </button>
              <button onClick={() => void copyText(createCommand, 'Create command')} style={smallButtonStyle}>
                Copy mkdir
              </button>
              <button onClick={() => void copyText(loginCommand, 'Login command')} style={smallButtonStyle}>
                Copy login
              </button>
            </div>
            <div
              style={{
                marginTop: '8px',
                padding: '7px 8px',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                background: 'var(--bg-primary)',
                color: 'var(--text-secondary)',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                lineHeight: 1.5,
                wordBreak: 'break-all',
              }}
            >
              {loginCommand || 'Enter an OAuth directory to build the login command.'}
            </div>
            {oauthStatus && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '5px', lineHeight: 1.5 }}>
                {oauthStatus}
              </div>
            )}
          </Field>
        ) : (
          <Field
            label="Environment variables"
            hint={
              kind === 'codex'
                ? 'Optionally set CODEX_HOME for OAuth multiplexing, or any other env var Codex reads.'
                : kind === 'claude-code'
                  ? 'Typically ANTHROPIC_API_KEY. Leave value blank to keep existing encrypted secret.'
                  : 'NVIDIA_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, etc.'
            }
          >
            {envRows.map((row, idx) => (
              <div key={idx} style={{ display: 'flex', gap: '6px', marginBottom: '4px' }}>
                <input
                  type="text"
                  value={row.key}
                  onChange={(e) => {
                    const next = envRows.slice()
                    next[idx] = { ...next[idx], key: e.target.value }
                    setEnvRows(next)
                  }}
                  placeholder="KEY"
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                />
                <input
                  type="password"
                  value={row.value}
                  onChange={(e) => {
                    const next = envRows.slice()
                    next[idx] = { ...next[idx], value: e.target.value }
                    setEnvRows(next)
                  }}
                  placeholder={instance && instance.envKeys.includes(row.key) ? '●●●●● (unchanged)' : 'value'}
                  style={{ ...inputStyle, flex: 2 }}
                />
                <button
                  onClick={() => {
                    setEnvRows(envRows.filter((_, i) => i !== idx))
                  }}
                  style={{
                    fontSize: '14px',
                    padding: '0 8px',
                    border: '1px solid var(--border)',
                    borderRadius: '4px',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                  aria-label="Remove row"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() => setEnvRows([...envRows, { key: '', value: '' }])}
              style={{
                fontSize: '11px',
                padding: '4px 8px',
                border: '1px dashed var(--border)',
                borderRadius: '4px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                marginTop: '4px',
              }}
            >
              + Add variable
            </button>
          </Field>
        )}

        {error && (
          <div style={{ fontSize: '11px', color: 'var(--danger, #d04848)', margin: '8px 0' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              fontSize: '12px',
              padding: '6px 12px',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              background: 'transparent',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              fontSize: '12px',
              padding: '6px 14px',
              border: '1px solid var(--accent)',
              borderRadius: '4px',
              background: 'var(--accent)',
              color: '#fff',
              cursor: 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  fontSize: '12px',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

const smallButtonStyle: React.CSSProperties = {
  fontSize: '11px',
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  background: 'transparent',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '4px' }}>
        {label}
      </div>
      {children}
      {hint && (
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: '11px',
        padding: '5px 10px',
        border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
        borderRadius: '4px',
        background: active ? 'var(--accent-subtle)' : 'transparent',
        color: 'var(--text-primary)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

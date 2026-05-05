/**
 * Providers tab — CRUD UI for named provider instances per agent kind.
 */

import { useEffect, useState } from 'react'
import type { AgentType, ProviderInstance } from '@shared/types'
import { agentLabel, defaultInstanceId } from '@shared/types'
import { providerInstanceInitials } from '@shared/providerInstanceInitials'
import {
  oauthCreateDirCommand,
  oauthEnvName,
  oauthLoginCommand,
  suggestedOauthDir,
} from '@shared/provider-auth-format'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import type { ProviderInstanceUpsertInput } from '../../../preload'

const AGENT_KINDS: AgentType[] = ['claude-code', 'codex', 'opencode']

const DEFAULT_ACCENT_PALETTE = [
  '#ff8a3d',
  '#3da8ff',
  '#7c5cff',
  '#3dd17a',
  '#ff5ca8',
  '#ffd23d',
]

function isDefault(inst: ProviderInstance): boolean {
  return inst.id === defaultInstanceId(inst.agentType)
}

export function ProvidersTab() {
  const loaded = useProviderInstanceStore((s) => s.loaded)
  const refresh = useProviderInstanceStore((s) => s.refresh)
  const error = useProviderInstanceStore((s) => s.error)
  const clearError = useProviderInstanceStore((s) => s.clearError)
  const forAgent = useProviderInstanceStore((s) => s.forAgent)
  const [editing, setEditing] = useState<ProviderInstance | null>(null)
  const [adding, setAdding] = useState<AgentType | null>(null)

  useEffect(() => {
    if (!loaded) refresh()
  }, [loaded, refresh])

  return (
    <div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.6 }}>
        Each agent kind can have multiple named credential sets — useful for
        switching between work / personal accounts without juggling shell env.
        Env values are encrypted at rest via Electron safeStorage; the
        renderer never sees decrypted secrets.
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '8px 10px',
            marginBottom: '12px',
            borderRadius: '4px',
            border: '1px solid var(--danger, #d04848)',
            background: 'rgba(208, 72, 72, 0.08)',
            fontSize: '11px',
            color: 'var(--text-primary)',
          }}
          role="alert"
        >
          <span style={{ flex: 1, lineHeight: 1.5 }}>{error}</span>
          <button
            onClick={clearError}
            style={{
              fontSize: '11px',
              padding: '2px 6px',
              border: '1px solid var(--border)',
              borderRadius: '3px',
              background: 'transparent',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {AGENT_KINDS.map((kind) => {
        const kindInstances = forAgent(kind)

        return (
          <div
            key={kind}
            style={{
              marginBottom: '18px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '12px 14px',
              background: 'var(--bg-tertiary)',
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '10px',
            }}>
              <div style={{ fontSize: '12px', fontWeight: 600 }}>{agentLabel(kind)}</div>
              <button
                onClick={() => setAdding(kind)}
                style={{
                  fontSize: '11px',
                  padding: '4px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: '4px',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                }}
              >
                + Add Instance
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {kindInstances.map((inst) => (
                <ProviderInstanceCard
                  key={inst.id}
                  instance={inst}
                  onEdit={() => setEditing(inst)}
                />
              ))}
              {kindInstances.length === 0 && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  No instances yet.
                </div>
              )}
            </div>
          </div>
        )
      })}

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

function ProviderInstanceCard({
  instance,
  onEdit,
}: {
  instance: ProviderInstance
  onEdit: () => void
}) {
  const remove = useProviderInstanceStore((s) => s.remove)
  const test = useProviderInstanceStore((s) => s.test)
  const accent = instance.accentColor ?? 'var(--accent)'
  const initials = providerInstanceInitials(instance.displayName)
  const def = isDefault(instance)
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null)
  const [probing, setProbing] = useState(false)

  async function handleTest() {
    setProbing(true)
    setProbe(null)
    try {
      const result = await test(instance.id)
      setProbe(result)
    } finally {
      setProbing(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        background: 'var(--bg-secondary)',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          background: accent,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '11px',
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 500 }}>
          {instance.displayName}
          {def && (
            <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>
              (default)
            </span>
          )}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {instance.authMode === 'oauth_dir'
            ? `OAuth dir: ${instance.oauthDir || '—'}`
            : instance.envKeys.length > 0
              ? instance.envKeys.map((k) => `${k} ●●●`).join(' · ')
              : 'No env overrides (uses shell / process env)'}
        </div>
        {probe && (
          <div
            style={{
              fontSize: '10px',
              marginTop: '4px',
              color: probe.ok ? 'var(--success, #3fb950)' : 'var(--danger, #d04848)',
              wordBreak: 'break-word',
            }}
          >
            {probe.ok ? '✓ ' : '✗ '}{probe.message}
          </div>
        )}
      </div>
      <button
        onClick={handleTest}
        disabled={probing}
        style={{
          fontSize: '11px',
          padding: '3px 8px',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          background: 'transparent',
          color: 'var(--text-secondary)',
          cursor: probing ? 'default' : 'pointer',
        }}
      >
        {probing ? 'Testing…' : 'Test'}
      </button>
      <button
        onClick={onEdit}
        style={{
          fontSize: '11px',
          padding: '3px 8px',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          background: 'transparent',
          color: 'var(--text-primary)',
          cursor: 'pointer',
        }}
      >
        Edit
      </button>
      {!def && (
        <button
          onClick={() => {
            if (confirm(`Delete instance "${instance.displayName}"?`)) {
              void remove(instance.id)
            }
          }}
          style={{
            fontSize: '11px',
            padding: '3px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            background: 'transparent',
            color: 'var(--danger, #d04848)',
            cursor: 'pointer',
          }}
        >
          Delete
        </button>
      )}
    </div>
  )
}

function ProviderInstanceDialog({
  instance,
  agentType,
  onClose,
}: {
  instance?: ProviderInstance
  agentType?: AgentType
  onClose: () => void
}) {
  const upsert = useProviderInstanceStore((s) => s.upsert)
  const kind = instance?.agentType ?? agentType!
  const [displayName, setDisplayName] = useState(instance?.displayName ?? '')
  const [accentColor, setAccentColor] = useState<string>(
    instance?.accentColor ?? DEFAULT_ACCENT_PALETTE[0],
  )
  const [authMode, setAuthMode] = useState<'env' | 'oauth_dir'>(
    instance?.authMode ?? 'env',
  )
  const [oauthDir, setOauthDir] = useState(instance?.oauthDir ?? '')
  // Env: existing keys are surfaced (values empty — main never re-sends).
  // User types new values to overwrite; leaving blank keeps the existing
  // encrypted blob for that key untouched (we send only filled-in keys).
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

  async function copyText(text: string, label: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setOauthStatus(`${label} copied.`)
    } catch {
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
        agentType: kind,
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
          {instance ? `Edit Instance — ${agentLabel(kind)}` : `New Instance — ${agentLabel(kind)}`}
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
              onChange={(e) => setOauthDir(e.target.value)}
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

/**
 * Per-chat workspace-template selector.
 *
 * Renders a small chip in the terminal strip header — current template
 * name on the left, dropdown arrow on the right. Clicking opens a menu
 * of named templates from this project's `workspace.yaml`. Selecting
 * one tears down the current panes and rehydrates from the chosen
 * template via `applyTemplate` (see `useTerminalLifecycle.ts`).
 *
 * The pinned-template indicator (outline star) marks the template
 * explicitly bound to THIS chat — `session_layouts.template_name`.
 * Picking a template auto-pins it; the "Clear pin" footer action
 * reverts to the implicit `default` fallback. Pinning is per-chat,
 * not per-project.
 *
 * Hidden in two cases:
 *   1. No active session.
 *   2. The project's workspace.yaml has zero templates beyond the
 *      implicit `default` (single template = nothing meaningful to
 *      switch to). Showing a one-option dropdown would be noise.
 */
import { useEffect, useState } from 'react'
import { parseWorkspaceConfig } from '@shared/workspace-config'
import { useTerminalStore } from '../../stores/terminal-store'
import { useAgentStore } from '../../stores/agent-store'
import { applyTemplate, clearTemplatePin, saveCurrentLayoutAsTemplate } from '../../hooks/useTerminalLifecycle'
import { sortTemplatesByRecency } from '../../services/templateUsage'

/** Outline star — fills only when "active" (currently-pinned). */
function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2.5l2.9 6.4 7 .7-5.3 4.7 1.6 6.9L12 17.6 5.8 21.2l1.6-6.9L2 9.6l7-.7L12 2.5z"
        fill={filled ? 'var(--accent)' : 'none'}
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TemplatePicker() {
  const activeSessionId = useTerminalStore((s) => s.activeSessionId)
  const session = useAgentStore((s) =>
    activeSessionId ? s.sessions.find((x) => x.id === activeSessionId) : undefined,
  )
  const projectPath = session?.projectPath
  const currentName = useTerminalStore((s) =>
    activeSessionId ? s.templateNames[activeSessionId] ?? null : null,
  )

  const [templateNames, setTemplateNames] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savingName, setSavingName] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Refresh the template list whenever the active project changes or
  // workspace.yaml is hot-reloaded. The picker is a passive read on
  // the YAML — `applyTemplate` is what actually mutates state.
  useEffect(() => {
    let cancelled = false
    if (!projectPath) { setTemplateNames([]); return }

    const refresh = async () => {
      try {
        const yaml = await window.api.app.getWorkspaceConfig(projectPath)
        if (cancelled) return
        if (!yaml) { setTemplateNames([]); return }
        const config = parseWorkspaceConfig(yaml)
        setTemplateNames(Object.keys(config.templates ?? {}))
      } catch {
        if (!cancelled) setTemplateNames([])
      }
    }
    refresh()

    const off = window.api.app.onWorkspaceChanged?.((changed) => {
      if (changed === projectPath) refresh()
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [projectPath])

  // Auto-clear feedback toasts inside the dropdown so the dropdown
  // doesn't carry stale "Saved" text into the next open.
  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 2400)
    return () => clearTimeout(t)
  }, [feedback])

  if (!activeSessionId || !projectPath) return null
  // We DO want to show the picker even with one template — it gates the
  // "Save current layout" affordance. Only hide when the project has
  // literally zero templates (workspace.yaml absent / empty).
  if (templateNames.length === 0) return null

  const display = currentName ?? 'default'
  const sortedNames = sortTemplatesByRecency(templateNames, projectPath)

  const onPick = async (name: string) => {
    setOpen(false)
    if (name === currentName || busy) return
    setBusy(true)
    try {
      await applyTemplate(activeSessionId, name, projectPath)
    } finally {
      setBusy(false)
    }
  }

  const onClearPin = () => {
    clearTemplatePin(activeSessionId)
    setFeedback({ kind: 'ok', text: 'Pin cleared — falls back to default.' })
  }

  const onSubmitSave = async () => {
    if (!savingName) return
    const name = savingName
    setBusy(true)
    try {
      const result = await saveCurrentLayoutAsTemplate(activeSessionId, projectPath, name)
      if (result.ok) {
        setSavingName(null)
        setFeedback({ kind: 'ok', text: `Saved "${name}".` })
        // Refresh template list so the new entry appears immediately.
        const yaml = await window.api.app.getWorkspaceConfig(projectPath)
        if (yaml) {
          const config = parseWorkspaceConfig(yaml)
          setTemplateNames(Object.keys(config.templates ?? {}))
        }
      } else {
        setFeedback({ kind: 'err', text: result.error })
      }
    } catch (e) {
      setFeedback({ kind: 'err', text: e instanceof Error ? e.message : 'Save failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Switch terminal template for this chat"
        style={{
          background: 'var(--bg-tertiary)',
          color: 'var(--text-secondary)',
          border: '1px solid var(--border)',
          borderRadius: '4px',
          padding: '2px 6px',
          fontSize: '10.5px',
          fontFamily: 'var(--font-mono)',
          cursor: busy ? 'wait' : 'pointer',
          outline: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          opacity: busy ? 0.6 : 1,
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>template:</span>
        {currentName && <StarIcon filled />}
        <span>{display}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '8px' }}>▾</span>
      </button>
      {open && (
        <div
          className="sb-floating-surface"
          onMouseLeave={() => { if (!savingName) setOpen(false) }}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.32)',
            zIndex: 50,
            minWidth: 200,
            padding: '4px 0',
          }}
        >
          {sortedNames.map((name) => {
            const isPinned = name === currentName
            const isImplicit = currentName == null && name === 'default'
            return (
              <button
                key={name}
                onClick={() => onPick(name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  padding: '4px 10px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-primary)',
                  fontSize: '11.5px',
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <span style={{ width: 12, display: 'inline-flex', justifyContent: 'center' }}>
                  {isPinned ? <StarIcon filled /> : null}
                </span>
                <span style={{ flex: 1 }}>{name}</span>
                {isImplicit && (
                  <span style={{ color: 'var(--text-muted)', fontSize: '9.5px' }}>implicit</span>
                )}
              </button>
            )
          })}

          <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />

          {currentName && (
            <button
              onClick={onClearPin}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 10px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              Clear pin
            </button>
          )}

          {savingName === null ? (
            <button
              onClick={() => { setSavingName(''); setFeedback(null) }}
              style={{
                display: 'block',
                width: '100%',
                padding: '4px 10px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              + Save current layout…
            </button>
          ) : (
            <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input
                autoFocus
                value={savingName}
                placeholder="Template name"
                onChange={(e) => setSavingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void onSubmitSave() }
                  if (e.key === 'Escape') { setSavingName(null) }
                }}
                style={{
                  fontSize: '11.5px',
                  fontFamily: 'var(--font-mono)',
                  padding: '3px 6px',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--accent)',
                  borderRadius: 3,
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => void onSubmitSave()}
                  disabled={busy || !savingName.trim()}
                  style={{
                    fontSize: '10.5px',
                    fontFamily: 'var(--font-mono)',
                    padding: '2px 8px',
                    background: 'var(--accent)',
                    color: 'var(--bg-primary)',
                    border: 'none',
                    borderRadius: 3,
                    cursor: busy ? 'wait' : 'pointer',
                    opacity: busy || !savingName.trim() ? 0.5 : 1,
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setSavingName(null)}
                  style={{
                    fontSize: '10.5px',
                    fontFamily: 'var(--font-mono)',
                    padding: '2px 8px',
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
              <div style={{ fontSize: '9.5px', color: 'var(--text-muted)', lineHeight: 1.3 }}>
                Captures pane layout + cwd + label. Startup commands
                (<code>on_start</code>) need to be added by hand.
              </div>
            </div>
          )}

          {feedback && (
            <div style={{
              padding: '4px 10px',
              fontSize: '10.5px',
              color: feedback.kind === 'err' ? 'var(--error)' : 'var(--success)',
              fontFamily: 'var(--font-mono)',
              borderTop: '1px solid var(--border)',
              marginTop: 4,
            }}>
              {feedback.text}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

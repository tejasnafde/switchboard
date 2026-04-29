/**
 * Per-chat workspace-template selector.
 *
 * Renders a small chip in the terminal strip header — current template
 * name on the left, dropdown arrow on the right. Clicking opens a menu
 * of named templates from this project's `workspace.yaml`. Selecting
 * one tears down the current panes and rehydrates from the chosen
 * template via `applyTemplate` (see `useTerminalLifecycle.ts`).
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
import { applyTemplate } from '../../hooks/useTerminalLifecycle'

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

  // Hide entirely when there's nothing meaningful to pick. A lone
  // `default` template is the implicit fallback — surfacing a dropdown
  // with one option just adds noise.
  if (!activeSessionId || !projectPath) return null
  if (templateNames.length <= 1) return null

  const display = currentName ?? 'default'

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
        <span>{display}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: '8px' }}>▾</span>
      </button>
      {open && (
        <div
          onMouseLeave={() => setOpen(false)}
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            zIndex: 50,
            minWidth: 140,
            padding: '4px 0',
          }}
        >
          {templateNames.map((name) => {
            const isCurrent = name === currentName || (currentName == null && name === 'default')
            return (
              <button
                key={name}
                onClick={() => onPick(name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
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
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-tertiary)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <span style={{ width: 12, color: 'var(--accent)' }}>{isCurrent ? '✓' : ''}</span>
                <span>{name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

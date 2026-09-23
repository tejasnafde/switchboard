import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { useMachineStore } from '../stores/machine-store'
import { fuzzyScore } from '../services/fuzzyScore'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('new-chat:picker')

export interface PickerTarget {
  projectPath: string
  machineId: string
  name: string
  where: string
}

/** Current project first, the rest in the sidebar's own order. */
export function orderPickerTargets(
  targets: PickerTarget[],
  current: { projectPath?: string; machineId?: string } | undefined,
): PickerTarget[] {
  if (!current?.projectPath) return targets
  const isCurrent = (t: PickerTarget) =>
    t.projectPath === current.projectPath && t.machineId === (current.machineId ?? 'local')
  return [...targets.filter(isCurrent), ...targets.filter((t) => !isCurrent(t))]
}

/**
 * cmd+shift+O. Always asks which project the new chat is for; the project
 * the user is in is on top and highlighted, so Enter keeps it.
 */
export function NewChatProjectPicker({
  open,
  current,
  onPick,
  onClose,
}: {
  open: boolean
  current: { projectPath?: string; machineId?: string } | undefined
  onPick: (projectPath: string, machineId: string) => void
  onClose: () => void
}) {
  const [local, setLocal] = useState<Project[]>([])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const remoteProjects = useMachineStore((s) => s.projects)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    window.api.app.getProjects()
      .then((projects: Project[]) => setLocal(projects))
      .catch((err: unknown) => log.warn('getProjects failed', err))
    // The chat editor usually holds focus when the shortcut fires and can take
    // it back on its own next frame, so focus once now and once after that.
    inputRef.current?.focus()
    const retry = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(retry)
  }, [open])

  const targets = useMemo(() => {
    const all: PickerTarget[] = local.map((p) => ({ projectPath: p.path, machineId: 'local', name: p.name, where: 'local' }))
    for (const machine of remotes) {
      if (connections[machine.id] !== 'connected') continue
      for (const p of remoteProjects[machine.id] ?? []) {
        all.push({ projectPath: p.path, machineId: machine.id, name: p.name, where: machine.name })
      }
    }
    const ordered = orderPickerTargets(all, current)
    if (!query.trim()) return ordered
    return ordered
      .map((t) => ({ t, score: fuzzyScore(query, `${t.name} ${t.where}`) }))
      .filter((x): x is { t: PickerTarget; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.t)
  }, [local, remotes, connections, remoteProjects, current, query])

  if (!open) return null
  // Clear on the way out too, so the next open never shows the last filter.
  const close = () => { setQuery(''); setIndex(0); onClose() }
  const pick = (t: PickerTarget) => { setQuery(''); setIndex(0); onPick(t.projectPath, t.machineId) }
  const selected = targets[Math.min(index, targets.length - 1)]
  const isCurrent = (t: PickerTarget) =>
    t.projectPath === current?.projectPath && t.machineId === (current?.machineId ?? 'local')

  return (
    <div
      onMouseDown={close}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)' }}
    >
      <div
        role="dialog"
        aria-label="New chat in"
        data-testid="new-chat-project-picker"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', top: 80, left: '50%', transform: 'translateX(-50%)', width: 440,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 16px 40px rgba(0,0,0,0.6)', overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          autoFocus
          value={query}
          placeholder="New chat in…"
          onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); close() }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, targets.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
            else if (e.key === 'Enter' && selected) { e.preventDefault(); pick(selected) }
          }}
          style={{
            width: '100%', padding: '11px 14px', border: 0, borderBottom: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-primary)', fontSize: 13, outline: 'none',
          }}
        />
        <div role="listbox" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {targets.length === 0 && (
            <div style={{ padding: '10px 14px', color: 'var(--text-muted)', fontSize: 12 }}>No matching project</div>
          )}
          {targets.map((t) => (
            <div
              key={`${t.machineId}:${t.projectPath}`}
              role="option"
              aria-selected={t === selected}
              onMouseDown={() => pick(t)}
              style={{
                padding: '8px 14px', display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', fontSize: 13,
                background: t === selected ? 'var(--bg-active)' : undefined, color: 'var(--text-primary)',
              }}
            >
              <span>{t.name}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                {isCurrent(t) ? 'current' : t.where}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

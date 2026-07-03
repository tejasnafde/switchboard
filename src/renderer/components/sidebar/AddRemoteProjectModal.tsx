/**
 * Add-project-on-remote modal: type an absolute directory path on a connected
 * machine with live autocomplete backed by files:list-dir over its tunnel.
 * Follows AddMachineModal's structure and machine-modal-* CSS classes.
 */
import { useEffect, useRef, useState } from 'react'
import { useMachineStore } from '../../stores/machine-store'
import { AppChannels, FilesChannels } from '@shared/ipc-channels'
import type { Project } from '@shared/types'
import { splitPath, pathCompletions, moveSelection, acceptSuggestion } from './pathComplete'
import { createRendererLogger } from '../../logger'

const log = createRendererLogger('sidebar:add-remote-project')
const DEBOUNCE_MS = 200
const MAX_SUGGESTIONS = 10

type ListDirResult = { ok: boolean; error?: string; entries: Array<{ name: string; isDir: boolean }> }
type AddProjectResult = Project | { ok: false; error: string }

export function AddRemoteProjectModal({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const [path, setPath] = useState('/')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [selected, setSelected] = useState(-1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mirrors `path` so an in-flight loadSuggestions can tell if the input moved on.
  const pathRef = useRef(path)
  pathRef.current = path

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache the last listed parent dir so re-listing only happens when the
  // typed path's dir actually changes, not on every keystroke of the partial.
  const cacheRef = useRef<{ dir: string; entries: Array<{ name: string; isDir: boolean }> } | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void loadSuggestions(path), DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [path])

  const loadSuggestions = async (typed: string) => {
    const { dir } = splitPath(typed)
    try {
      let entries = cacheRef.current?.dir === dir ? cacheRef.current.entries : null
      if (!entries) {
        const res = await window.api.routing.invokeOn<ListDirResult>(machineId, FilesChannels.LIST_DIR, dir, '')
        // The input may have moved to a different dir while this round-trip was
        // in flight - a slow earlier response must not clobber a newer one.
        if (splitPath(pathRef.current).dir !== dir) return
        if (!res.ok) {
          setSuggestions([])
          return
        }
        entries = res.entries
        cacheRef.current = { dir, entries }
      }
      setSuggestions(pathCompletions(typed, entries).slice(0, MAX_SUGGESTIONS))
      setSelected(-1)
    } catch (err) {
      // Permission errors / nonexistent dirs are routine while typing - no error spam.
      log.warn('list-dir failed', err)
      setSuggestions([])
    }
  }

  const accept = (suggestion: string) => {
    setPath(acceptSuggestion(suggestion))
    setSuggestions([])
    setSelected(-1)
  }

  const submit = async () => {
    const trimmed = path.trim()
    if (submitting || !trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.api.routing.invokeOn<AddProjectResult>(machineId, AppChannels.ADD_PROJECT_PATH, trimmed)
      if ('ok' in result && result.ok === false) {
        setError(result.error)
        return
      }
      await useMachineStore.getState().syncMachine(machineId)
      onClose()
    } catch (err) {
      log.warn('add-project-path failed', err)
      setError(err instanceof Error ? err.message : 'Failed to add project')
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose()
      return
    }
    if (e.key === 'ArrowDown' && suggestions.length > 0) {
      e.preventDefault()
      setSelected((s) => moveSelection(s, 1, suggestions.length))
      return
    }
    if (e.key === 'ArrowUp' && suggestions.length > 0) {
      e.preventDefault()
      setSelected((s) => moveSelection(s, -1, suggestions.length))
      return
    }
    if (e.key === 'Tab' && selected >= 0 && suggestions[selected]) {
      e.preventDefault()
      accept(suggestions[selected])
      return
    }
    if (e.key === 'Enter') {
      if (selected >= 0 && suggestions[selected]) {
        e.preventDefault()
        accept(suggestions[selected])
        return
      }
      void submit()
    }
  }

  return (
    <div className="machine-modal-overlay" onClick={onClose}>
      <div className="machine-modal" onClick={(e) => e.stopPropagation()}>
        <div className="machine-modal-title">Add project</div>

        <div className="machine-modal-section">
          <div className="machine-modal-label">Absolute path on remote</div>
          <input
            className="machine-modal-input"
            placeholder="/home/ubuntu/myproject"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
          />
          {suggestions.length > 0 && (
            <div className="machine-modal-hostlist">
              {suggestions.map((s, i) => (
                <button
                  key={s}
                  className={`machine-modal-host${i === selected ? ' is-selected' : ''}`}
                  onClick={() => accept(s)}
                >
                  <span className="machine-modal-host-alias">{s}</span>
                </button>
              ))}
            </div>
          )}
          {error && <div className="machine-modal-empty">{error}</div>}
        </div>

        <div className="machine-modal-actions">
          <button className="machine-modal-cancel" onClick={onClose}>Cancel</button>
          <button className="machine-modal-add" onClick={() => void submit()} disabled={submitting || !path.trim()}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

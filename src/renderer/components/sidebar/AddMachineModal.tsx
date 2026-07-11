/**
 * Add/edit-machine modal: pick a host from ~/.ssh/config, type one manually,
 * or (when `editMachine` is set) patch an existing machine's fields via the
 * store's update(). Escape closes; Enter submits the manual form when valid.
 */
import { useEffect, useState } from 'react'
import { useMachineStore } from '../../stores/machine-store'
import { filterSshHosts } from './sshHostFilter'
import { isDuplicateMachine, parsePort, validateManualMachine } from './addMachineValidation'
import { createRendererLogger } from '../../logger'
import type { Machine, SshHost } from '@shared/machines'

const log = createRendererLogger('sidebar:add-machine')

export function AddMachineModal({ onClose, editMachine }: { onClose: () => void; editMachine?: Machine }) {
  const sshHosts = useMachineStore((s) => s.sshHosts)
  const remotes = useMachineStore((s) => s.remotes)
  const add = useMachineStore((s) => s.add)
  const update = useMachineStore((s) => s.update)

  const isEdit = !!editMachine
  const [name, setName] = useState(editMachine?.name ?? '')
  const [host, setHost] = useState(editMachine?.sshHost ?? '')
  const [user, setUser] = useState(editMachine?.sshUser ?? '')
  const [port, setPort] = useState(String(editMachine?.sshPort ?? 22))
  // Default to ubuntu: our VMs all run the agent as the ubuntu user (the ssh
  // login user varies per machine). Clear the field to run as the login user.
  const [remoteUser, setRemoteUser] = useState(isEdit ? (editMachine?.remoteUser ?? '') : 'ubuntu')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [search, setSearch] = useState('')
  // Guards against a double-click firing two CREATE calls before the first
  // one's re-hydrate lands (which would add the same host twice).
  const [adding, setAdding] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Escape closes regardless of which input (if any) holds focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filteredHosts = filterSshHosts(sshHosts, search)
  const parsedPort = parsePort(port)

  // When editing, the machine must not collide with itself in the dup check.
  const dedupeTargets = isEdit ? remotes.filter((m) => m.id !== editMachine.id) : remotes
  const manualValidation = validateManualMachine(dedupeTargets, { name, host, user, port })
  const manualDuplicate = !manualValidation.ok && manualValidation.reason === 'duplicate'

  const runAs = () => remoteUser.trim() || null
  const failureMessage = isEdit ? 'Could not save machine - check the log' : 'Could not add machine - check the log'

  const addFromSsh = async (h: SshHost) => {
    if (adding || isDuplicateMachine(remotes, { sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null })) return
    setAdding(true)
    setSubmitError(null)
    try {
      const created = await add({ name: h.alias, sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null, sshPort: h.port, remoteUser: runAs() })
      if (created) onClose()
      else setSubmitError(failureMessage)
    } finally {
      setAdding(false)
    }
  }

  const submitManual = async () => {
    if (adding || !manualValidation.ok) return
    setAdding(true)
    setSubmitError(null)
    try {
      if (isEdit) {
        await update(editMachine.id, { ...manualValidation.input, remoteUser: runAs() })
        onClose()
      } else {
        const created = await add({ ...manualValidation.input, remoteUser: runAs() })
        if (created) onClose()
        else setSubmitError(failureMessage)
      }
    } catch (err) {
      // add() swallows its own failures; this covers update() rejecting.
      log.warn('submit failed', err)
      setSubmitError(failureMessage)
    } finally {
      setAdding(false)
    }
  }

  // Enter submits the manual form - attached only to its own inputs so it
  // never fights the ssh-host search box (whose Enter does nothing).
  const onManualKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submitManual()
    }
  }

  return (
    <div className="machine-modal-overlay" onClick={onClose}>
      <div className="machine-modal" onClick={(e) => e.stopPropagation()}>
        <div className="machine-modal-title">{isEdit ? 'Edit machine' : 'Add machine'}</div>

        {!isEdit && sshHosts.length > 0 && (
          <div className="machine-modal-section">
            <div className="machine-modal-label">From ~/.ssh/config</div>
            <input
              className="machine-modal-input"
              placeholder={`Search ${sshHosts.length} hosts...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="machine-modal-hostlist">
              {filteredHosts.map((h) => {
                const isDup = isDuplicateMachine(remotes, { sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null })
                return (
                  <button
                    key={h.alias}
                    className="machine-modal-host"
                    onClick={() => void addFromSsh(h)}
                    disabled={adding || isDup}
                    title={isDup ? 'Already added' : undefined}
                  >
                    <span className="machine-modal-host-alias">
                      {h.alias}
                      {isDup ? ' (already added)' : ''}
                    </span>
                    <span className="machine-modal-host-addr">
                      {h.user ? `${h.user}@` : ''}
                      {h.hostName}
                      {h.port !== 22 ? `:${h.port}` : ''}
                    </span>
                  </button>
                )
              })}
              {filteredHosts.length === 0 && <div className="machine-modal-empty">No matching hosts</div>}
            </div>
          </div>
        )}

        <div className="machine-modal-section">
          <div className="machine-modal-label">{isEdit ? 'Connection' : 'Manual'}</div>
          <input
            className="machine-modal-input"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onManualKeyDown}
            autoFocus={isEdit || sshHosts.length === 0}
          />
          <input
            className="machine-modal-input"
            placeholder="Host (e.g. 10.0.0.4)"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={onManualKeyDown}
          />
          <div className="machine-modal-row">
            <input
              className="machine-modal-input"
              placeholder="User"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              onKeyDown={onManualKeyDown}
            />
            <input
              className="machine-modal-input"
              style={{ width: '70px' }}
              placeholder="Port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              onKeyDown={onManualKeyDown}
            />
          </div>
          {port.trim() !== '' && parsedPort === null && (
            <div className="machine-modal-error">Port must be an integer between 1 and 65535</div>
          )}
          {manualDuplicate && (
            <div className="machine-modal-error">This machine is already added</div>
          )}
        </div>

        <div className="machine-modal-section">
          <button
            className="machine-modal-advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <span className="sidebar-chevron">{advancedOpen ? '▼' : '▶'}</span> Advanced
          </button>
          {advancedOpen && (
            <>
              <div className="machine-modal-label">Run as user (sudo, optional)</div>
              <input
                className="machine-modal-input"
                placeholder="e.g. ubuntu - leave blank to use the login user"
                value={remoteUser}
                onChange={(e) => setRemoteUser(e.target.value)}
                onKeyDown={onManualKeyDown}
              />
            </>
          )}
        </div>

        {submitError && <div className="machine-modal-error">{submitError}</div>}

        <div className="machine-modal-actions">
          <button className="machine-modal-cancel" onClick={onClose}>Cancel</button>
          <button className="machine-modal-add" onClick={() => void submitManual()} disabled={!manualValidation.ok || adding}>
            {adding ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

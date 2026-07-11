/**
 * Add-machine picker: pick a host from ~/.ssh/config, or type one manually.
 * Selecting/submitting creates a remote machine row via the machine store and
 * immediately kicks off its first connect. With `editMachine` set, the same
 * form edits an existing machine in place (ssh picker hidden, saves via
 * update() - no connect side effect).
 */
import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useMachineStore } from '../../stores/machine-store'
import { filterSshHosts } from './sshHostFilter'
import { isDuplicateMachine, parsePort } from './addMachineValidation'
import { createRendererLogger } from '../../logger'
import type { SshHost, Machine, MachineInput } from '@shared/machines'

const log = createRendererLogger('sidebar:add-machine')

export function AddMachineModal({ onClose, editMachine }: { onClose: () => void; editMachine?: Machine }) {
  const sshHosts = useMachineStore((s) => s.sshHosts)
  const remotes = useMachineStore((s) => s.remotes)
  const add = useMachineStore((s) => s.add)
  const update = useMachineStore((s) => s.update)
  const connect = useMachineStore((s) => s.connect)

  const editing = !!editMachine
  const [name, setName] = useState(editMachine?.name ?? '')
  const [host, setHost] = useState(editMachine?.sshHost ?? '')
  const [user, setUser] = useState(editMachine?.sshUser ?? '')
  const [port, setPort] = useState(String(editMachine?.sshPort ?? 22))
  // Default to ubuntu: our VMs all run the agent as the ubuntu user (the ssh
  // login user varies per machine). Clear the field to run as the login user.
  const [remoteUser, setRemoteUser] = useState(editing ? (editMachine?.remoteUser ?? '') : 'ubuntu')
  const [search, setSearch] = useState('')
  // Guards against a double-click firing two CREATE calls before the first
  // one's re-hydrate lands (which would add the same host twice).
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filteredHosts = filterSshHosts(sshHosts, search)
  const parsedPort = parsePort(port)

  const runAs = () => remoteUser.trim() || null

  // Add, auto-connect, close. A null result (create threw) keeps the modal
  // open with an inline error instead of failing silently.
  const submit = async (input: MachineInput) => {
    setAdding(true)
    setError(null)
    try {
      const created = await add(input)
      if (created) {
        void connect(created.id)
        onClose()
      } else {
        setError('Could not add machine. Check the app log for details.')
      }
    } finally {
      setAdding(false)
    }
  }

  const saveEdit = async (patch: Partial<MachineInput>) => {
    if (!editMachine) return
    setAdding(true)
    setError(null)
    try {
      await update(editMachine.id, patch)
      onClose()
    } catch (err) {
      log.warn('machine update failed', err)
      setError('Could not save changes. Check the app log for details.')
    } finally {
      setAdding(false)
    }
  }

  const addFromSsh = (h: SshHost) => {
    if (adding || isDuplicateMachine(remotes, { sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null })) return
    void submit({ name: h.alias, sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null, sshPort: h.port, remoteUser: runAs() })
  }

  // In edit mode the machine's own row must not read as a duplicate of itself.
  const dupCandidates = editing ? remotes.filter((m) => m.id !== editMachine!.id) : remotes
  const manualDup =
    !!host.trim() && isDuplicateMachine(dupCandidates, { sshHost: host.trim(), sshUser: user.trim() || null })
  const manualReady = !!host.trim() && parsedPort !== null && !manualDup && !adding

  const addManual = () => {
    if (!manualReady || parsedPort === null) return
    const fields = {
      name: name.trim() || host.trim(),
      sshHost: host.trim(),
      sshUser: user.trim() || null,
      sshPort: parsedPort,
      remoteUser: runAs(),
    }
    if (editing) void saveEdit(fields)
    else void submit(fields)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter' && target.tagName === 'INPUT') {
      // Enter in the ssh-config search picks the top match; Enter anywhere
      // else submits the manual form. Without the split, Enter while
      // searching would submit a half-abandoned manual entry.
      if (target.dataset.sshSearch) {
        if (filteredHosts.length > 0) addFromSsh(filteredHosts[0])
      } else {
        addManual()
      }
    }
  }

  return (
    <div className="machine-modal-overlay" onClick={onClose}>
      <div className="machine-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="machine-modal-title">{editing ? 'Edit machine' : 'Add machine'}</div>

        {!editing && sshHosts.length > 0 && (
          <div className="machine-modal-section">
            <div className="machine-modal-label">From ~/.ssh/config</div>
            <input
              className="machine-modal-input"
              placeholder={`Search ${sshHosts.length} hosts...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-ssh-search="true"
              autoFocus
            />
            <div className="machine-modal-hostlist">
              {filteredHosts.map((h) => {
                const isDup = isDuplicateMachine(remotes, { sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null })
                return (
                  <button
                    key={h.alias}
                    className="machine-modal-host"
                    onClick={() => addFromSsh(h)}
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
          <div className="machine-modal-label">{editing ? 'Connection' : sshHosts.length > 0 ? 'Manual' : 'Host'}</div>
          <input
            className="machine-modal-input"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={editing || sshHosts.length === 0}
          />
          <input className="machine-modal-input" placeholder="Host (e.g. 10.0.0.4)" value={host} onChange={(e) => setHost(e.target.value)} />
          <div className="machine-modal-row">
            <input className="machine-modal-input" placeholder="User" value={user} onChange={(e) => setUser(e.target.value)} />
            <input
              className="machine-modal-input"
              style={{ width: '70px' }}
              placeholder="Port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          {port.trim() !== '' && parsedPort === null && (
            <div className="machine-modal-empty">Port must be an integer between 1 and 65535</div>
          )}
          {manualDup && <div className="machine-modal-empty">This host is already added</div>}
        </div>

        <details className="machine-modal-section machine-modal-advanced">
          <summary className="machine-modal-label">Advanced</summary>
          <div className="machine-modal-label">Run as user (sudo, optional)</div>
          <input
            className="machine-modal-input"
            placeholder="e.g. ubuntu - leave blank to use the login user"
            value={remoteUser}
            onChange={(e) => setRemoteUser(e.target.value)}
          />
        </details>

        {error && <div className="machine-modal-error">{error}</div>}

        <div className="machine-modal-actions">
          <button className="machine-modal-cancel" onClick={onClose}>Cancel</button>
          <button className="machine-modal-add" onClick={addManual} disabled={!manualReady}>
            {editing ? (adding ? 'Saving…' : 'Save') : adding ? 'Adding…' : 'Add + connect'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Add-machine picker: pick a host from ~/.ssh/config, or type one manually.
 * Selecting/submitting creates a remote machine row via the machine store.
 */
import { useState } from 'react'
import { useMachineStore } from '../../stores/machine-store'
import type { SshHost } from '@shared/machines'

export function AddMachineModal({ onClose }: { onClose: () => void }) {
  const sshHosts = useMachineStore((s) => s.sshHosts)
  const add = useMachineStore((s) => s.add)

  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('22')
  const [remoteUser, setRemoteUser] = useState('')

  const runAs = () => remoteUser.trim() || null

  const addFromSsh = async (h: SshHost) => {
    await add({ name: h.alias, sshAlias: h.alias, sshHost: h.hostName ?? h.alias, sshUser: h.user ?? null, sshPort: h.port, remoteUser: runAs() })
    onClose()
  }

  const addManual = async () => {
    if (!host.trim()) return
    await add({
      name: name.trim() || host.trim(),
      sshHost: host.trim(),
      sshUser: user.trim() || null,
      sshPort: Number(port) || 22,
      remoteUser: runAs(),
    })
    onClose()
  }

  return (
    <div className="machine-modal-overlay" onClick={onClose}>
      <div className="machine-modal" onClick={(e) => e.stopPropagation()}>
        <div className="machine-modal-title">Add machine</div>

        <div className="machine-modal-section">
          <div className="machine-modal-label">Run as user (sudo, optional)</div>
          <input
            className="machine-modal-input"
            placeholder="e.g. ubuntu - leave blank to use the login user"
            value={remoteUser}
            onChange={(e) => setRemoteUser(e.target.value)}
          />
        </div>

        {sshHosts.length > 0 && (
          <div className="machine-modal-section">
            <div className="machine-modal-label">From ~/.ssh/config</div>
            {sshHosts.map((h) => (
              <button key={h.alias} className="machine-modal-host" onClick={() => void addFromSsh(h)}>
                <span className="machine-modal-host-alias">{h.alias}</span>
                <span className="machine-modal-host-addr">
                  {h.user ? `${h.user}@` : ''}
                  {h.hostName}
                  {h.port !== 22 ? `:${h.port}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="machine-modal-section">
          <div className="machine-modal-label">Manual</div>
          <input className="machine-modal-input" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="machine-modal-input" placeholder="Host (e.g. 10.0.0.4)" value={host} onChange={(e) => setHost(e.target.value)} />
          <div className="machine-modal-row">
            <input className="machine-modal-input" placeholder="User" value={user} onChange={(e) => setUser(e.target.value)} />
            <input className="machine-modal-input" style={{ width: '70px' }} placeholder="Port" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
        </div>

        <div className="machine-modal-actions">
          <button className="machine-modal-cancel" onClick={onClose}>Cancel</button>
          <button className="machine-modal-add" onClick={() => void addManual()} disabled={!host.trim()}>Add</button>
        </div>
      </div>
    </div>
  )
}

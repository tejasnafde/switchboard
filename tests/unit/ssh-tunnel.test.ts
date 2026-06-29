/**
 * buildTunnelCommand: the `ssh` argv that opens a forwarding tunnel and starts
 * the remote backend over it. VS Code-style: -L forwards a local port to the
 * remote server's port, and the remote command boots the server bound there.
 */
import { describe, it, expect } from 'vitest'
import { buildTunnelCommand } from '../../src/main/machines/sshTunnel'
import type { Machine } from '@shared/machines'

const mk = (over: Partial<Machine>): Machine => ({
  id: 'm1', name: 'prod', sshAlias: null, sshHost: '10.0.0.4', sshUser: 'ubuntu',
  sshPort: 22, sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
})

describe('buildTunnelCommand', () => {
  it('forwards localPort -> remotePort and runs the server command', () => {
    const { command, args } = buildTunnelCommand(mk({}), { localPort: 7681, remotePort: 8765, remoteCommand: 'node server.js' })
    expect(command).toBe('ssh')
    expect(args).toContain('-L')
    expect(args).toContain('7681:127.0.0.1:8765')
    expect(args[args.length - 1]).toBe('node server.js')
  })

  it('uses the ssh config alias as the host (lets ~/.ssh/config resolve user/port)', () => {
    const { args } = buildTunnelCommand(mk({ sshAlias: 'prod-vm' }), { localPort: 1, remotePort: 2, remoteCommand: 'x' })
    expect(args).toContain('prod-vm')
    expect(args).not.toContain('ubuntu@10.0.0.4')
    expect(args).not.toContain('-p') // alias carries the port
  })

  it('falls back to user@host and -p port when there is no alias', () => {
    const { args } = buildTunnelCommand(mk({ sshAlias: null, sshUser: 'deploy', sshHost: 'h.dev', sshPort: 2222 }), {
      localPort: 1, remotePort: 2, remoteCommand: 'x',
    })
    expect(args).toContain('deploy@h.dev')
    expect(args).toEqual(expect.arrayContaining(['-p', '2222']))
  })

  it('omits user@ when no user is set (ssh uses the current user)', () => {
    const { args } = buildTunnelCommand(mk({ sshAlias: null, sshUser: null, sshHost: 'h.dev' }), {
      localPort: 1, remotePort: 2, remoteCommand: 'x',
    })
    expect(args).toContain('h.dev')
    expect(args.some((a) => a.includes('@'))).toBe(false)
  })

  it('sets batch mode + keepalive so a dead link fails fast instead of hanging', () => {
    const { args } = buildTunnelCommand(mk({}), { localPort: 1, remotePort: 2, remoteCommand: 'x' })
    expect(args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']))
    expect(args.join(' ')).toMatch(/ServerAliveInterval=/)
  })
})

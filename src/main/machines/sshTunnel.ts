/**
 * Build the `ssh` argv that opens a forwarding tunnel to a remote and boots the
 * backend over it: `-L localPort:127.0.0.1:remotePort` forwards, and the final
 * argument is the remote command that starts the server bound to remotePort.
 *
 * Prefer the ~/.ssh/config alias as the host (ssh resolves user/port/key from
 * config); fall back to user@host + -p port otherwise.
 */
import type { Machine } from '@shared/machines'

export interface TunnelOpts {
  localPort: number
  remotePort: number
  remoteCommand: string
}

export function buildTunnelCommand(machine: Machine, opts: TunnelOpts): { command: string; args: string[] } {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${opts.localPort}:127.0.0.1:${opts.remotePort}`,
  ]

  if (machine.sshAlias) {
    args.push(machine.sshAlias)
  } else {
    if (machine.sshPort && machine.sshPort !== 22) args.push('-p', String(machine.sshPort))
    args.push(machine.sshUser ? `${machine.sshUser}@${machine.sshHost}` : machine.sshHost)
  }

  args.push(opts.remoteCommand)
  return { command: 'ssh', args }
}

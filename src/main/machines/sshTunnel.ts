/**
 * Build the `ssh` argv that opens a forwarding tunnel to a remote and boots the
 * backend over it: `-L localPort:127.0.0.1:remotePort` forwards, and the final
 * argument is the remote command that starts the server bound to remotePort.
 *
 * Prefer the ~/.ssh/config alias as the host (ssh resolves user/port/key from
 * config); fall back to user@host + -p port otherwise.
 */
import type { Machine } from '@shared/machines'
import { asUserScript } from './remoteExec'

export interface TunnelOpts {
  localPort: number
  remotePort: number
  remoteCommand: string
}

/**
 * sshAlias/sshHost/sshUser are user-typed and DB-stored, then land positionally
 * in ssh argv with no `--` separator (ssh has none that's reliable). A value
 * starting with `-` would be parsed as an ssh option (e.g. a fake
 * ProxyCommand = code execution at connect time); whitespace/control chars
 * can smuggle extra argv-adjacent content. Reject both up front.
 */
const UNSAFE_SSH_ARG = /^-|[\s\x00-\x1f]/

function assertSafeSshArg(field: string, value: string): void {
  if (UNSAFE_SSH_ARG.test(value)) {
    throw new Error(`unsafe ssh ${field} "${value}": must not start with "-" or contain whitespace/control characters`)
  }
}

/**
 * The ssh argv that selects the host: the ~/.ssh/config alias when set (ssh
 * resolves user/port/key), else `-p port` + `user@host`. Shared by the tunnel
 * and the provisioning probe.
 */
export function sshHostArgs(machine: Machine): string[] {
  if (machine.sshAlias) {
    assertSafeSshArg('alias', machine.sshAlias)
    return [machine.sshAlias]
  }
  const args: string[] = []
  if (machine.sshPort && machine.sshPort !== 22) args.push('-p', String(machine.sshPort))
  assertSafeSshArg('host', machine.sshHost)
  if (machine.sshUser) assertSafeSshArg('user', machine.sshUser)
  args.push(machine.sshUser ? `${machine.sshUser}@${machine.sshHost}` : machine.sshHost)
  return args
}

export function buildTunnelCommand(machine: Machine, opts: TunnelOpts): { command: string; args: string[] } {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${opts.localPort}:127.0.0.1:${opts.remotePort}`,
    ...sshHostArgs(machine),
    asUserScript(machine.remoteUser, opts.remoteCommand),
  ]
  return { command: 'ssh', args }
}

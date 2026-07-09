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
 * Options every ssh invocation shares.
 *
 * `StrictHostKeyChecking=accept-new` is required alongside `BatchMode=yes`:
 * BatchMode disables all prompts, so a first-time host (or an IAP/ProxyCommand
 * tunnel whose key isn't in known_hosts yet) would otherwise fail outright with
 * "Host key verification failed" instead of being trusted-on-first-use.
 * `accept-new` records the key for a brand-new host but still REFUSES a host
 * whose key has *changed* - so the MITM protection that plain StrictHostKeyChecking
 * gives is preserved; only the interactive first-connect prompt is removed.
 *
 * These are constant flags (never user input), so the UNSAFE_SSH_ARG guard in
 * sshHostArgs is unaffected - that guard only vets the alias/host/user values.
 */
export const SSH_COMMON_OPTS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  // Fail a dead/black-holed host in 10s instead of the OS TCP timeout (~75s);
  // applies to the tunnel, the probe, and every provisioning command.
  '-o', 'ConnectTimeout=10',
]

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
    ...SSH_COMMON_OPTS,
    // 15s x 2 missed keepalives = a dead tunnel is noticed in ~30s, not the
    // OpenSSH default 30s x 3 = 90s.
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `${opts.localPort}:127.0.0.1:${opts.remotePort}`,
    ...sshHostArgs(machine),
    asUserScript(machine.remoteUser, opts.remoteCommand),
  ]
  return { command: 'ssh', args }
}

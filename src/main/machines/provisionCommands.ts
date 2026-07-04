/**
 * ssh commands for auto-provisioning. The probe runs a tiny node one-liner on
 * the remote that reports its runtime + the installed server version marker, as
 * a single JSON line `parseProbeOutput` reads. The node source uses only single
 * quotes so it survives the remote shell inside the double-quoted `-e` arg.
 */
import type { Machine } from '@shared/machines'
import { sshHostArgs, SSH_COMMON_OPTS } from './sshTunnel'
import { asUserScript } from './remoteExec'

/** Where the provisioned server + its version marker live on the remote. */
export const REMOTE_SERVER_DIR = '$HOME/.switchboard-server'

const PROBE_SOURCE =
  "const fs=require('fs');" +
  "let s=null;try{s=fs.readFileSync((process.env.HOME||'')+'/.switchboard-server/version','utf8').trim()}catch(e){}" +
  'process.stdout.write(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules,server:s}))'

export function buildProbeCommand(machine: Machine): { command: string; args: string[] } {
  return {
    command: 'ssh',
    args: [
      ...SSH_COMMON_OPTS,
      ...sshHostArgs(machine),
      asUserScript(machine.remoteUser, `node -e "${PROBE_SOURCE}" 2>/dev/null || true`),
    ],
  }
}

/** ssh that runs an arbitrary remote shell command (stdin is forwarded). */
export function buildRemoteShellCommand(machine: Machine, remoteCommand: string): { command: string; args: string[] } {
  return {
    command: 'ssh',
    args: [...SSH_COMMON_OPTS, ...sshHostArgs(machine), remoteCommand],
  }
}

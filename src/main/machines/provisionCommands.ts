/**
 * ssh commands for auto-provisioning. The probe runs a tiny node one-liner on
 * the remote that reports its runtime + the installed server version marker, as
 * a single JSON line `parseProbeOutput` reads. The node source uses only single
 * quotes so it survives the remote shell inside the double-quoted `-e` arg.
 */
import type { Machine } from '@shared/machines'
import { buildMachineRemoteCommand, SSH_COMMON_OPTS } from './sshTunnel'
import { asUserScript } from './remoteExec'
import { BRIDGE_EXTENSION_DIRNAME } from '../ide/code-server-manager'

/** Where the provisioned server + its version marker live on the remote. */
export const REMOTE_SERVER_DIR = '$HOME/.switchboard-server'

const PROBE_SOURCE =
  "const fs=require('fs');const H=process.env.HOME||'';" +
  "const rd=p=>{try{return fs.readFileSync(H+p,'utf8').trim()}catch(e){return null}};" +
  "let s=rd('/.switchboard-server/version');" +
  // The sb-bridge payload marker. Read here so provisioning can skip shipping
  // the extension when the remote already has it: the payload is ~20KB, and on
  // an IAP-tunneled host any upload costs ~2 minutes regardless of size, so
  // shipping it on every connect would tax every reconnect.
  `let b=rd('/.switchboard-server/ide-extensions/${BRIDGE_EXTENSION_DIRNAME}/.sb-marker');` +
  'process.stdout.write(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules,server:s,bridge:b}))'

export function buildProbeCommand(machine: Machine): { command: string; args: string[] } {
  return buildMachineRemoteCommand(
    machine,
    asUserScript(machine.remoteUser, `node -e "${PROBE_SOURCE}" 2>/dev/null || true`),
    SSH_COMMON_OPTS,
  )
}

/** ssh that runs an arbitrary remote shell command (stdin is forwarded). */
export function buildRemoteShellCommand(machine: Machine, remoteCommand: string): { command: string; args: string[] } {
  return buildMachineRemoteCommand(machine, remoteCommand, SSH_COMMON_OPTS)
}

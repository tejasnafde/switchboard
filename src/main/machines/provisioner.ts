/** Probe a remote, and if needed upload the server bundle + npm-install it. */
import type { Machine } from '@shared/machines'
import { buildProbeCommand, buildRemoteShellCommand, REMOTE_SERVER_DIR } from './provisionCommands'
import { parseProbeOutput } from './remoteProbe'
import { planProvision, type ProvisionAction } from './provisionPlan'
import { remotePackageJson, remoteInstallScript } from './provisionSetup'
import { asUserScript, asUserUpload } from './remoteExec'

export interface ProcRunner {
  exec: (command: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>
}

export interface ProvisionInputs {
  appVersion: string
  betterSqliteVersion: string
  bundle: string
}

export interface ProvisionResult {
  action: ProvisionAction
  reason: string
}

export async function provisionRemote(
  machine: Machine,
  inputs: ProvisionInputs,
  runner: ProcRunner,
  log?: (msg: string) => void,
): Promise<ProvisionResult> {
  const probeCmd = buildProbeCommand(machine)
  const probeOut = await runner.exec(probeCmd.command, probeCmd.args)
  const plan = planProvision(parseProbeOutput(probeOut.stdout), inputs.appVersion)
  log?.(`provision ${machine.id}: ${plan.action} (${plan.reason})`)

  if (plan.action === 'ready' || plan.action === 'no-node') return plan

  const run = async (label: string, remoteCommand: string, stdin?: string) => {
    log?.(`provision ${machine.id}: ${label}`)
    const c = buildRemoteShellCommand(machine, remoteCommand)
    const res = await runner.exec(c.command, c.args, stdin)
    if (res.code !== 0) throw new Error(`${label} failed (${res.code}): ${res.stderr || remoteCommand}`)
  }

  const u = machine.remoteUser
  await run('mkdir server dir', asUserScript(u, `mkdir -p ${REMOTE_SERVER_DIR}`))
  await run('upload server bundle', asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/index.cjs`), inputs.bundle)
  await run(
    'upload package.json',
    asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/package.json`),
    JSON.stringify(remotePackageJson(inputs.appVersion, inputs.betterSqliteVersion), null, 2),
  )
  await run('npm install (this can take a minute)', asUserScript(u, remoteInstallScript(inputs.appVersion)))
  log?.(`provision ${machine.id}: install complete`)

  return plan
}

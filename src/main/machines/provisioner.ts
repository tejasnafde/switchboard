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

  const run = async (remoteCommand: string, stdin?: string) => {
    const c = buildRemoteShellCommand(machine, remoteCommand)
    const res = await runner.exec(c.command, c.args, stdin)
    if (res.code !== 0) throw new Error(`remote step failed (${res.code}): ${res.stderr || remoteCommand}`)
  }

  const u = machine.remoteUser
  await run(asUserScript(u, `mkdir -p ${REMOTE_SERVER_DIR}`))
  await run(asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/index.cjs`), inputs.bundle)
  await run(
    asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/package.json`),
    JSON.stringify(remotePackageJson(inputs.appVersion, inputs.betterSqliteVersion), null, 2),
  )
  await run(asUserScript(u, remoteInstallScript(inputs.appVersion)))

  return plan
}

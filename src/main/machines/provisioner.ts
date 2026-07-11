/** Probe a remote, and if needed upload the server bundle + npm-install it. */
import type { Machine } from '@shared/machines'
import { buildProbeCommand, buildRemoteShellCommand, REMOTE_SERVER_DIR } from './provisionCommands'
import { parseProbeOutput } from './remoteProbe'
import { planProvision, type ProvisionAction } from './provisionPlan'
import { remotePackageJson, remoteInstallScript, claudeSymlinkScript, versionMarkerScript } from './provisionSetup'
import { asUserScript, asUserUpload } from './remoteExec'
import { summarizeSshError } from './sshError'

export interface ProcRunner {
  // stdin is either an inline string (small payloads like package.json) or a
  // file to stream in (the server bundle, which is too large to buffer).
  // timeoutMs caps the whole command; the runner applies its own default when
  // omitted (long enough for npm install).
  exec: (command: string, args: string[], stdin?: string | { file: string }, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>
}

export interface ProvisionInputs {
  appVersion: string
  betterSqliteVersion: string
  claudeSdkVersion: string
  bundlePath: string
}

export interface ProvisionResult {
  action: ProvisionAction
  reason: string
}

/** The server bundle targets node20 (scripts/build-server.mjs) and
 *  better-sqlite3@12 needs node >= 20; anything older passes the "has node"
 *  check but crashes at launch behind a generic health-check timeout. */
const MIN_NODE_MAJOR = 20

/** The probe is a trivial node one-liner and ConnectTimeout=10 already bounds
 *  the ssh connect, so anything past 30s means a wedged remote - fail fast
 *  instead of eating the runner's install-sized default. */
const PROBE_TIMEOUT_MS = 30_000

function assertSupportedNode(version: string | null): void {
  if (!version) return
  const match = version.match(/^v?(\d+)/)
  const major = match ? Number(match[1]) : NaN
  if (!Number.isFinite(major)) return
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`remote node ${version} is too old, need >= ${MIN_NODE_MAJOR}`)
  }
}

export async function provisionRemote(
  machine: Machine,
  inputs: ProvisionInputs,
  runner: ProcRunner,
  log?: (msg: string) => void,
  /** Coarse per-step progress ('upload server bundle', 'npm install ...') for the connect UI. Never fires when the probe reports ready. */
  onProgress?: (label: string) => void,
): Promise<ProvisionResult> {
  const probeCmd = buildProbeCommand(machine)
  const probeOut = await runner.exec(probeCmd.command, probeCmd.args, undefined, PROBE_TIMEOUT_MS)
  if (probeOut.code !== 0) {
    throw new Error(`ssh probe failed (${probeOut.code}): ${summarizeSshError(probeOut.stderr)}`)
  }
  const probe = parseProbeOutput(probeOut.stdout)
  assertSupportedNode(probe.node)
  const plan = planProvision(probe, inputs.appVersion)
  log?.(`provision ${machine.id}: ${plan.action} (${plan.reason})`)

  if (plan.action === 'ready' || plan.action === 'no-node') return plan

  const run = async (label: string, remoteCommand: string, stdin?: string | { file: string }) => {
    log?.(`provision ${machine.id}: ${label}`)
    onProgress?.(label)
    const c = buildRemoteShellCommand(machine, remoteCommand)
    const res = await runner.exec(c.command, c.args, stdin)
    if (res.code !== 0) throw new Error(`${label} failed (${res.code}): ${summarizeSshError(res.stderr) || remoteCommand}`)
  }

  const u = machine.remoteUser
  await run('mkdir server dir', asUserScript(u, `mkdir -p ${REMOTE_SERVER_DIR}`))
  await run('upload server bundle', asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/index.cjs`), { file: inputs.bundlePath })
  await run(
    'upload package.json',
    asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/package.json`),
    JSON.stringify(remotePackageJson(inputs.appVersion, inputs.betterSqliteVersion, inputs.claudeSdkVersion), null, 2),
  )
  await run('npm install (this can take a minute)', asUserScript(u, remoteInstallScript()))

  // Best-effort: puts `claude` on PATH for remote shells, but the server
  // resolves the SDK binary itself, so a miss must not fail provisioning.
  try {
    await run('link claude CLI onto PATH', asUserScript(u, claudeSymlinkScript()))
  } catch (err) {
    log?.(`provision ${machine.id}: claude CLI symlink failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // Marker last: a half-finished install must never probe as ready.
  await run('write version marker', asUserScript(u, versionMarkerScript(inputs.appVersion)))
  log?.(`provision ${machine.id}: install complete`)

  return plan
}

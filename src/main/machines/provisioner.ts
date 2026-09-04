/** Probe a remote, and if needed upload the server bundle + npm-install it. */
import type { Machine } from '@shared/machines'
import { buildProbeCommand, buildRemoteShellCommand, REMOTE_SERVER_DIR } from './provisionCommands'
import { parseProbeOutput } from './remoteProbe'
import { planProvision, type ProvisionAction } from './provisionPlan'
import { remotePackageJson, remoteInstallScript, claudeSymlinkScript, codexEnsureScript, versionMarkerScript, managedToolsMarkerScript, codeServerEnsureScript, bridgeSeedScript, bridgeMarker, REMOTE_CODEX_VERSION, type BridgeFile } from './provisionSetup'
import { planManagedTools, type ManagedToolPlan } from './managedToolPlan'
import { CODE_SERVER_VERSION } from '../ide/code-server-manager'
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
  /** Pinned `@openai/codex`; defaults to REMOTE_CODEX_VERSION. */
  codexVersion?: string
  bundlePath: string
  /** Bundled sb-bridge payload, base64'd by the caller (see bundledBridgeFiles).
   *  Empty = seed nothing and log why; the remote still gets a working backend,
   *  just a workbench that cannot reach Switchboard. */
  bridgeFiles: BridgeFile[]
}

export interface ProvisionResult {
  action: ProvisionAction
  reason: string
  /** What the managed CLIs needed, decided independently of `action`. */
  tools?: ManagedToolPlan
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
  /** Coarse per-step progress for the connect UI ('upload server bundle', ...). */
  onStep?: (label: string) => void,
): Promise<ProvisionResult> {
  // Resolved once, up front, so both the uploaded package.json (which pins
  // the version npm will actually install) and the managed-tool plan/repair
  // below (which decides whether that pin is already satisfied) agree on the
  // same override - threading two different values through the same connect
  // is how a package.json could ask npm for one Codex version while the
  // repair step separately chased another.
  const codexVersion = inputs.codexVersion ?? REMOTE_CODEX_VERSION
  onStep?.('checking remote')
  const probeCmd = buildProbeCommand(machine)
  const probeOut = await runner.exec(probeCmd.command, probeCmd.args, undefined, PROBE_TIMEOUT_MS)
  if (probeOut.code !== 0) {
    const cause = summarizeSshError(probeOut.stderr)
    throw new Error(`ssh probe failed (${probeOut.code})${cause ? `: ${cause}` : ''}`)
  }
  const probe = parseProbeOutput(probeOut.stdout)
  assertSupportedNode(probe.node)
  const plan = planProvision(probe, inputs.appVersion)
  log?.(`provision ${machine.id}: ${plan.action} (${plan.reason})`)

  const run = async (label: string, remoteCommand: string, stdin?: string | { file: string }) => {
    log?.(`provision ${machine.id}: ${label}`)
    onStep?.(label)
    const c = buildRemoteShellCommand(machine, remoteCommand)
    const res = await runner.exec(c.command, c.args, stdin)
    if (res.code !== 0) throw new Error(`${label} failed (${res.code}): ${summarizeSshError(res.stderr) || remoteCommand}`)
  }

  const u = machine.remoteUser

  // Rides every connect (idempotent, fast when installed). Non-fatal: agents
  // and terminals must connect even if the IDE install fails.
  if (plan.action !== 'no-node') {
    try {
      await run('ensure remote IDE (one-time download)', asUserScript(u, codeServerEnsureScript(CODE_SERVER_VERSION)))
    } catch (err) {
      log?.(`provision ${machine.id}: remote IDE install failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
    // Separate step from the binary install so a bridge-seed failure is retried
    // on the next connect rather than masked by an already-present code-server.
    // Also non-fatal: a bridge-less workbench still edits files, it just can't
    // route keybindings or selections back to Switchboard.
    //
    // Gated on the probe's marker: shipping the ~20KB payload costs ~2 minutes
    // on an IAP-tunneled host (measured - the penalty is per-upload, not per
    // byte), which would otherwise be added to every single connect.
    if (inputs.bridgeFiles.length === 0) {
      log?.(`provision ${machine.id}: no bundled bridge extension found - remote workbench keybindings will not reach Switchboard`)
    } else if (probe.bridge === bridgeMarker(inputs.bridgeFiles)) {
      log?.(`provision ${machine.id}: bridge extension already current (${probe.bridge})`)
    } else {
      try {
        await run('seed workbench bridge extension', asUserScript(u, bridgeSeedScript(inputs.bridgeFiles)))
      } catch (err) {
        log?.(`provision ${machine.id}: bridge extension seed failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Managed CLI repair, decided from the probed EXECUTABLES AND VERSIONS rather
  // than from `plan.action`. This used to live inside the version-marker gate,
  // so a remote that probed `ready` returned above and never relinked a missing
  // `claude` nor noticed an outdated pinned `codex` - a ready server could carry
  // a broken or years-old tool indefinitely. Non-fatal throughout: terminals and
  // the other provider must still connect when one CLI cannot be repaired.
  const toolPlan = planManagedTools(probe, {
    claudeSdkVersion: inputs.claudeSdkVersion,
    codexVersion,
  })

  const ensureManagedTools = async (force: boolean): Promise<void> => {
    const claudeNeeded = force || toolPlan.claude.action !== 'ok'
    const codexNeeded = force || toolPlan.codex.action !== 'ok'
    if (!claudeNeeded && !codexNeeded && toolPlan.markerCurrent) {
      log?.(`provision ${machine.id}: managed CLIs current (${toolPlan.marker})`)
      return
    }
    let allOk = true
    if (claudeNeeded) {
      log?.(`provision ${machine.id}: claude ${toolPlan.claude.action} - ${toolPlan.claude.reason}`)
      // claudeSymlinkScript only relinks whatever @anthropic-ai/claude-agent-sdk
      // ALREADY sits under node_modules - it does not (and cannot) install a
      // different pinned version. On the FORCE path that is fine: `force` means
      // a fresh npm install just ran with the new pin in package.json, so
      // whatever is on disk now IS the desired version. On a `ready` server
      // (force=false), an `install`/`upgrade` action means the desired version
      // is NOT what's on disk, and no install happened this connect - relinking
      // would "succeed" against the stale package and the tools marker would
      // then claim a version we never actually installed. That silent
      // convergence lie is exactly what managedToolPlan.ts's marker exists to
      // prevent, so leave it unconverged here instead: the next connect that
      // takes the full install path (an app version bump, which is what changes
      // this pin) will install the real thing.
      if (!force && toolPlan.claude.action !== 'repair') {
        allOk = false
        log?.(
          `provision ${machine.id}: claude needs ${toolPlan.claude.action} but a ready server can only relink an ` +
          `already-installed SDK - leaving unconverged until a full reprovision installs ${inputs.claudeSdkVersion}`,
        )
      } else {
        try {
          await run('link claude CLI onto PATH', asUserScript(u, claudeSymlinkScript()))
        } catch (err) {
          allOk = false
          log?.(`provision ${machine.id}: claude CLI symlink failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    if (codexNeeded) {
      log?.(`provision ${machine.id}: codex ${toolPlan.codex.action} - ${toolPlan.codex.reason}`)
      try {
        await run('ensure Codex CLI', asUserScript(u, codexEnsureScript(codexVersion)))
      } catch (err) {
        allOk = false
        log?.(`provision ${machine.id}: Codex install failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Marker last, and only when EVERY tool step succeeded: a partial repair
    // must re-run on the next connect rather than probe as done.
    if (!allOk) return
    try {
      await run('write managed tools marker', asUserScript(u, managedToolsMarkerScript(toolPlan.marker)))
    } catch (err) {
      log?.(`provision ${machine.id}: tools marker write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (plan.action === 'ready') {
    await ensureManagedTools(false)
    return { ...plan, tools: toolPlan }
  }
  if (plan.action === 'no-node') return plan
  await run('mkdir server dir', asUserScript(u, `mkdir -p ${REMOTE_SERVER_DIR}`))
  await run('upload server bundle', asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/index.cjs`), { file: inputs.bundlePath })
  await run(
    'upload package.json',
    asUserUpload(u, `cat > ${REMOTE_SERVER_DIR}/package.json`),
    JSON.stringify(remotePackageJson(inputs.appVersion, inputs.betterSqliteVersion, inputs.claudeSdkVersion, codexVersion), null, 2),
  )
  await run('npm install (this can take a minute)', asUserScript(u, remoteInstallScript()))

  // Forced: the install above just replaced node_modules, so the probe's view
  // of the tools is stale by definition - relink and re-verify unconditionally.
  await ensureManagedTools(true)

  // Marker last: a half-finished install must never probe as ready.
  await run('write version marker', asUserScript(u, versionMarkerScript(inputs.appVersion)))
  log?.(`provision ${machine.id}: install complete`)

  return { ...plan, tools: toolPlan }
}

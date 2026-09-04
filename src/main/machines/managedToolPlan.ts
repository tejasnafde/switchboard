/**
 * Decide what the remote's MANAGED CLIs (claude, codex) need, independently of
 * the Switchboard server version.
 *
 * Every CLI repair used to hang off `$HOME/.switchboard-server/version`: a
 * remote whose marker equalled the app version planned as `ready`, the
 * provisioner returned early, and a missing `claude` link or an outdated pinned
 * `codex` was never touched. Tool state and server state are genuinely
 * independent - a perfectly current server can have a broken tool - so they get
 * separate plans and separate markers.
 *
 * Pure: the provisioner acts on the actions and surfaces the reasons.
 */
import type { RemoteProbe } from './remoteProbe'

export interface ManagedToolVersions {
  /** Version of `@anthropic-ai/claude-agent-sdk` whose bundled CLI we link. */
  claudeSdkVersion: string
  /** Pinned `@openai/codex` version. */
  codexVersion: string
}

export type ToolAction =
  /** Installed, current, and resolvable. */
  | 'ok'
  /** Never installed here. */
  | 'install'
  /** Installed but the wrong version. */
  | 'upgrade'
  /** Right version installed, but the managed executable does not resolve. */
  | 'repair'

export interface ToolDecision {
  action: ToolAction
  reason: string
}

export interface ManagedToolPlan {
  claude: ToolDecision
  codex: ToolDecision
  /** Marker to write once the work below succeeds. */
  marker: string
  /** The remote already records exactly this pin set. */
  markerCurrent: boolean
  /** True when both tools are `ok` AND the marker is current - nothing to do. */
  satisfied: boolean
}

/**
 * Marker for a set of PINNED tool versions. Deliberately not the app version:
 * bumping a pin has to re-provision tools even on a server that is otherwise
 * untouched, and shipping a new app without touching the pins must not.
 *
 * Kept to `[A-Za-z0-9._-]` because it is written into, and compared inside, a
 * remote shell script.
 */
export function managedToolsMarker(desired: ManagedToolVersions): string {
  const safe = (v: string) => v.replace(/[^A-Za-z0-9.]+/g, '-')
  return `claude-${safe(desired.claudeSdkVersion)}_codex-${safe(desired.codexVersion)}`
}

function decide(
  label: string,
  installed: string | null,
  resolvedBin: string | null,
  wanted: string,
): ToolDecision {
  if (!installed && !resolvedBin) return { action: 'install', reason: `${label} is not installed` }
  if (installed && installed !== wanted) {
    return { action: 'upgrade', reason: `${label} ${installed} != pinned ${wanted}` }
  }
  // A matching version with no resolvable executable is the silent-failure case
  // the marker alone would hide: the package is on disk but the managed link is
  // absent or dangling, so the provider picks a shadow binary or nothing.
  if (!resolvedBin) return { action: 'repair', reason: `${label} ${wanted} is installed but not linked onto PATH` }
  if (!installed) return { action: 'repair', reason: `${label} resolves but its installed version is unknown` }
  return { action: 'ok', reason: `${label} ${installed} linked at ${resolvedBin}` }
}

/**
 * Note what is NOT read here: `probe.server`. That decoupling is the whole
 * point - see planProvision for the server's own decision.
 */
export function planManagedTools(probe: RemoteProbe, desired: ManagedToolVersions): ManagedToolPlan {
  const claude = decide('claude', probe.claudeVersion, probe.claudeBin, desired.claudeSdkVersion)
  const codex = decide('codex', probe.codexVersion, probe.codexBin, desired.codexVersion)
  const marker = managedToolsMarker(desired)
  // The marker is a record that provisioning finished this pin set, never a
  // substitute for the evidence above: a current marker cannot make a missing
  // executable `ok`, and a stale one cannot make a healthy tool broken. It only
  // decides whether the marker itself still has to be written.
  const markerCurrent = probe.tools === marker
  return {
    claude,
    codex,
    marker,
    markerCurrent,
    satisfied: claude.action === 'ok' && codex.action === 'ok' && markerCurrent,
  }
}

/**
 * Diagnostics snapshot + plain-text report for Settings > About.
 *
 * The main process collects `DiagnosticsSnapshot` (ipc/diagnostics.ts); the
 * renderer renders the key facts and copies `formatDiagnosticsReport` to the
 * clipboard so a user on a slow machine can paste one block into an issue.
 *
 * Contract: nothing here may identify the user. No env vars, no paths under
 * the home directory except the logs directory, no tokens.
 */

export interface DiagnosticsProcess {
  /** Electron process type: Browser, Tab, GPU, Utility, ... */
  type: string
  pid: number
  cpuPercent: number
  /** Working set in MiB. */
  memoryMb: number
  /** Utility processes carry a name (e.g. "Node.js: pty host"). */
  name?: string
}

export interface DiagnosticsSnapshot {
  appVersion: string
  arch: string
  platform: string
  osVersion: string
  /** `app.runningUnderARM64Translation` - x64 build on Apple silicon / Windows on ARM. */
  translated: boolean
  versions: { electron: string; chrome: string; node: string }
  uptimeSeconds: number
  memory: { totalMb: number; freeMb: number }
  processes: DiagnosticsProcess[]
  /** `app.getGPUFeatureStatus()` - feature name -> status string. */
  gpu: Record<string, string>
  theme: string
  /** null when the count is not cheaply available on this host. */
  livePtys: number | null
  liveSessions: number | null
  logsDir: string
}

function pad(value: string | number, width: number, align: 'left' | 'right' = 'left'): string {
  const text = String(value)
  if (text.length >= width) return text
  const fill = ' '.repeat(width - text.length)
  return align === 'left' ? text + fill : fill + text
}

export function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`
  return `${Math.round(mb)} MiB`
}

/** Processes sorted by working set, largest first. Stable for equal sizes. */
export function sortProcessesByMemory(processes: DiagnosticsProcess[]): DiagnosticsProcess[] {
  return [...processes].sort((a, b) => b.memoryMb - a.memoryMb)
}

function processTable(processes: DiagnosticsProcess[]): string[] {
  const rows = sortProcessesByMemory(processes)
  const typeWidth = Math.max(4, ...rows.map((p) => p.type.length))
  const header = `${pad('type', typeWidth)}  ${pad('pid', 7, 'right')}  ${pad('cpu%', 6, 'right')}  ${pad('mem', 10, 'right')}  name`
  const lines = rows.map((p) =>
    `${pad(p.type, typeWidth)}  ${pad(p.pid, 7, 'right')}  ${pad(p.cpuPercent.toFixed(1), 6, 'right')}  ${pad(formatMb(p.memoryMb), 10, 'right')}  ${p.name ?? ''}`.trimEnd(),
  )
  return [header, ...lines]
}

export function formatDiagnosticsReport(d: DiagnosticsSnapshot): string {
  const totalProcessMb = d.processes.reduce((sum, p) => sum + p.memoryMb, 0)
  const gpuEntries = Object.entries(d.gpu).sort(([a], [b]) => a.localeCompare(b))
  const lines: string[] = [
    `Switchboard ${d.appVersion}`,
    `platform:    ${d.platform} ${d.osVersion} (${d.arch}${d.translated ? ', translated' : ''})`,
    `electron:    ${d.versions.electron}  chrome ${d.versions.chrome}  node ${d.versions.node}`,
    `uptime:      ${formatUptime(d.uptimeSeconds)}`,
    `memory:      ${formatMb(d.memory.freeMb)} free of ${formatMb(d.memory.totalMb)}; app processes ${formatMb(totalProcessMb)}`,
    `theme:       ${d.theme}`,
    `live:        ${d.livePtys ?? '?'} pty, ${d.liveSessions ?? '?'} agent sessions`,
    `logs:        ${d.logsDir}`,
    '',
    `processes (${d.processes.length}):`,
    ...processTable(d.processes),
  ]
  if (gpuEntries.length > 0) {
    lines.push('', 'gpu:')
    const keyWidth = Math.max(...gpuEntries.map(([k]) => k.length))
    for (const [key, value] of gpuEntries) lines.push(`${pad(key, keyWidth)}  ${value}`)
  }
  return lines.join('\n')
}

// ─── About > Diagnostics disclosure ──────────────────────────────
//
// The section is collapsed by default. These two decisions are what keep that
// from hiding something the user needed, and they are pure so they can be
// tested without rendering the Settings modal.

/** Settings key holding the user's last open/closed choice. */
export const DIAGNOSTICS_EXPANDED_SETTING_KEY = 'about.diagnosticsExpanded'

/**
 * One line shown on the collapsed row.
 *
 * A disclosure that previews nothing is a blind door: the user has to open it
 * to learn whether it was worth opening. This answers the three questions the
 * section is usually opened for - which chip, how busy, how heavy - so most
 * visits need no click at all.
 *
 * `livePtys` is null when the host cannot count cheaply. That segment is then
 * dropped rather than printed as "? terminals", because a question mark reads
 * as a fault. Zero is different from unknown and is still shown.
 */
export function diagnosticsAppFootprintMb(processes: DiagnosticsProcess[]): number {
  return processes.reduce((sum, p) => sum + p.memoryMb, 0)
}

export function diagnosticsGist(d: DiagnosticsSnapshot): string {
  const appMb = diagnosticsAppFootprintMb(d.processes)
  const segments = [d.translated ? `${d.arch} translated` : d.arch]
  if (d.livePtys !== null) {
    segments.push(`${d.livePtys} ${d.livePtys === 1 ? 'terminal' : 'terminals'}`)
  }
  segments.push(formatMb(appMb))
  return segments.join(' · ')
}

/**
 * Whether the section starts open.
 *
 * A translated build - an x64 app on Apple silicon, or on Windows on ARM - is
 * slow for a reason the user can fix by installing the native build, and it
 * is the only diagnostic here that is a call to action rather than a fact. So
 * it opens the section for a user who has never answered.
 *
 * It does NOT override a deliberate close, and the ordering here is the whole
 * decision. Forcing it open on every visit would re-open a section the UI had
 * just animated shut and told the user it remembered, which makes the saved
 * preference silently inert for exactly the population that sees the warning
 * most. The call to action survives the close anyway: `diagnosticsGist` keeps
 * `arm64 translated` on the COLLAPSED row, in the warning colour.
 *
 * `stored` is the raw settings string. It is null before it loads and can be
 * anything at all if it was hand-edited, so it is parsed strictly and any
 * other value counts as "never answered".
 */
export function diagnosticsDefaultExpanded(
  d: DiagnosticsSnapshot | null,
  stored: string | null,
): boolean {
  if (stored === 'true') return true
  if (stored === 'false') return false
  return Boolean(d?.translated)
}

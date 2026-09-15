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

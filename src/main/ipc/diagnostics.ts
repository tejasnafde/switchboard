/**
 * Settings > About > Diagnostics. One snapshot of the host so a user on a
 * slow machine can paste a single block and we know why.
 *
 * Electron-only: reads `app.getAppMetrics()` / GPU status, so it is
 * registered from main/index.ts rather than ipc/app.ts (which also runs on
 * the headless server). Never returns env vars, tokens or home paths other
 * than the logs directory.
 */
import { app, shell } from 'electron'
import { totalmem, freemem } from 'os'
import type { BackendHost } from '../backend/host'
import { AppChannels } from '@shared/ipc-channels'
import type { DiagnosticsSnapshot, DiagnosticsProcess } from '@shared/diagnostics-report'
import { createMainLogger, getLogDir } from '../logger'
import { getSetting } from '../db/database'

const log = createMainLogger('ipc:diagnostics')

export interface DiagnosticsDeps {
  livePtys: () => number | null
  liveSessions: () => number | null
}

const KIB_PER_MIB = 1024
const BYTES_PER_MIB = 1024 * 1024

function appProcesses(): DiagnosticsProcess[] {
  return app.getAppMetrics().map((m) => ({
    type: m.type,
    pid: m.pid,
    cpuPercent: Number(m.cpu?.percentCPUUsage ?? 0),
    // workingSetSize is reported in kilobytes.
    memoryMb: Math.round((m.memory?.workingSetSize ?? 0) / KIB_PER_MIB),
    ...(m.name ? { name: m.name } : {}),
  }))
}

function gpuStatus(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(app.getGPUFeatureStatus()).map(([k, v]) => [k, String(v)]),
  )
}

export function collectDiagnostics(deps: DiagnosticsDeps): DiagnosticsSnapshot {
  return {
    appVersion: app.getVersion(),
    arch: process.arch,
    platform: process.platform,
    osVersion: process.getSystemVersion(),
    translated: app.runningUnderARM64Translation,
    versions: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
    },
    uptimeSeconds: process.uptime(),
    memory: {
      totalMb: Math.round(totalmem() / BYTES_PER_MIB),
      freeMb: Math.round(freemem() / BYTES_PER_MIB),
    },
    processes: appProcesses(),
    gpu: gpuStatus(),
    theme: getSetting('theme') ?? 'dark',
    livePtys: deps.livePtys(),
    liveSessions: deps.liveSessions(),
    logsDir: getLogDir(),
  }
}

export function registerDiagnosticsHandlers(host: BackendHost, deps: DiagnosticsDeps): void {
  host.handle(AppChannels.GET_DIAGNOSTICS, (): DiagnosticsSnapshot => collectDiagnostics(deps))

  host.handle(AppChannels.OPEN_LOGS_FOLDER, async (): Promise<{ ok: boolean; error?: string }> => {
    const dir = getLogDir()
    if (!dir) return { ok: false, error: 'Log directory is not initialised yet.' }
    // shell.openPath resolves to '' on success and to an error string otherwise.
    const error = await shell.openPath(dir)
    if (error) {
      log.warn('openPath failed', { error })
      return { ok: false, error }
    }
    return { ok: true }
  })
}

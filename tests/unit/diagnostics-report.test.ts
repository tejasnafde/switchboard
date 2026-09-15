import { describe, it, expect } from 'vitest'
import {
  formatDiagnosticsReport,
  formatMb,
  formatUptime,
  sortProcessesByMemory,
  type DiagnosticsSnapshot,
} from '@shared/diagnostics-report'

const snapshot: DiagnosticsSnapshot = {
  appVersion: '0.8.55',
  arch: 'x64',
  platform: 'darwin',
  osVersion: '15.6.0',
  translated: true,
  versions: { electron: '33.4.11', chrome: '130.0.6723.191', node: '20.18.3' },
  uptimeSeconds: 3725,
  memory: { totalMb: 16384, freeMb: 512 },
  processes: [
    { type: 'Browser', pid: 100, cpuPercent: 1.234, memoryMb: 210 },
    { type: 'Tab', pid: 200, cpuPercent: 12.5, memoryMb: 640 },
    { type: 'Utility', pid: 300, cpuPercent: 0, memoryMb: 48, name: 'Node.js: pty host' },
    { type: 'GPU', pid: 400, cpuPercent: 3, memoryMb: 210 },
  ],
  gpu: { webgl: 'enabled', gpu_compositing: 'disabled_software' },
  theme: 'dark',
  livePtys: 3,
  liveSessions: 2,
  logsDir: '/Users/x/Library/Application Support/switchboard/logs',
}

describe('formatDiagnosticsReport', () => {
  it('leads with version, platform, chip and the translation flag', () => {
    const report = formatDiagnosticsReport(snapshot)
    const lines = report.split('\n')
    expect(lines[0]).toBe('Switchboard 0.8.55')
    expect(lines[1]).toBe('platform:    darwin 15.6.0 (x64, translated)')
    expect(lines[2]).toContain('electron:    33.4.11  chrome 130.0.6723.191  node 20.18.3')
    expect(report).toContain('uptime:      1h 2m 5s')
    expect(report).toContain('memory:      512 MiB free of 16.0 GiB; app processes 1.1 GiB')
    expect(report).toContain('live:        3 pty, 2 agent sessions')
    expect(report).toContain('logs:        /Users/x/Library/Application Support/switchboard/logs')
  })

  it('omits the translated marker on a native build', () => {
    const report = formatDiagnosticsReport({ ...snapshot, translated: false, arch: 'arm64' })
    expect(report).toContain('(arm64)')
    expect(report).not.toContain('translated')
  })

  it('lists processes as an aligned table sorted by memory, largest first', () => {
    const report = formatDiagnosticsReport(snapshot)
    const start = report.indexOf('processes (4):')
    const table = report.slice(start).split('\n').slice(1, 6)
    expect(table[0]).toMatch(/^type\s+pid\s+cpu%\s+mem\s+name$/)
    expect(table[1]).toMatch(/^Tab\s+200\s+12\.5\s+640 MiB$/)
    // Equal sizes keep input order (stable sort).
    expect(table[2]).toMatch(/^Browser\s+100\s+1\.2\s+210 MiB$/)
    expect(table[3]).toMatch(/^GPU\s+400\s+3\.0\s+210 MiB$/)
    expect(table[4]).toMatch(/^Utility\s+300\s+0\.0\s+48 MiB\s+Node\.js: pty host$/)
    // Every row aligns on the same pid column.
    const pidCols = table.slice(1).map((row) => row.search(/\d+\s+\d+\.\d/))
    expect(new Set(pidCols).size).toBe(1)
  })

  it('prints unknown live counts as ? and skips the gpu block when empty', () => {
    const report = formatDiagnosticsReport({ ...snapshot, livePtys: null, liveSessions: null, gpu: {} })
    expect(report).toContain('live:        ? pty, ? agent sessions')
    expect(report).not.toContain('gpu:')
  })

  it('sorts gpu feature names for a stable diff between two reports', () => {
    const report = formatDiagnosticsReport(snapshot)
    const gpuStart = report.indexOf('gpu:')
    const gpuLines = report.slice(gpuStart).split('\n').slice(1)
    expect(gpuLines).toEqual(['gpu_compositing  disabled_software', 'webgl            enabled'])
  })

  it('never includes anything but the logs path under the home dir', () => {
    const report = formatDiagnosticsReport(snapshot)
    const homePaths = report.match(/\/Users\/[^\s]+/g) ?? []
    expect(homePaths).toEqual(['/Users/x/Library/Application'])
  })
})

describe('helpers', () => {
  it('formatUptime scales units', () => {
    expect(formatUptime(5)).toBe('5s')
    expect(formatUptime(65)).toBe('1m 5s')
    expect(formatUptime(3600)).toBe('1h 0m 0s')
    expect(formatUptime(-3)).toBe('0s')
  })

  it('formatMb switches to GiB at 1024', () => {
    expect(formatMb(1023)).toBe('1023 MiB')
    expect(formatMb(1024)).toBe('1.0 GiB')
    expect(formatMb(1536)).toBe('1.5 GiB')
  })

  it('sortProcessesByMemory does not mutate its input', () => {
    const input = [...snapshot.processes]
    sortProcessesByMemory(input)
    expect(input).toEqual(snapshot.processes)
  })
})

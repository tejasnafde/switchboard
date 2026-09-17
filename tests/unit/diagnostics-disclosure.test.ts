/**
 * About > Diagnostics is collapsed by default.
 *
 * Two pure decisions make that safe, and both are here rather than inside the
 * component so they can be reasoned about without a render:
 *
 *   - the GIST, so the collapsed row is not a blind door. A user must be able
 *     to answer "what chip, how many terminals, how much memory" without
 *     opening anything.
 *   - the DEFAULT OPEN state. One diagnostic is actionable rather than
 *     informational: a build running under Rosetta is slow for a reason the
 *     user can fix. Hiding that behind a click would quietly cost performance,
 *     so a translated build forces the section open even if the user last
 *     closed it.
 */
import { describe, it, expect } from 'vitest'
import {
  diagnosticsGist,
  diagnosticsDefaultExpanded,
  DIAGNOSTICS_EXPANDED_SETTING_KEY,
} from '../../src/shared/diagnostics-report'
import type { DiagnosticsSnapshot } from '../../src/shared/diagnostics-report'

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    appVersion: '0.8.58',
    arch: 'arm64',
    platform: 'darwin',
    osVersion: '26.6.2',
    translated: false,
    versions: { electron: '43.4.1', chrome: '150.0.7871.224', node: '24.18.1' },
    uptimeSeconds: 900,
    memory: { totalMb: 8192, freeMb: 98 },
    processes: [
      { pid: 1, type: 'Browser', cpuPercent: 0, memoryMb: 86 },
      { pid: 2, type: 'Tab', cpuPercent: 0, memoryMb: 130 },
      { pid: 3, type: 'GPU', cpuPercent: 0, memoryMb: 43 },
    ],
    gpu: {},
    theme: 'dark',
    livePtys: 12,
    liveSessions: 14,
    logsDir: '/logs',
    ...overrides,
  }
}

describe('diagnosticsGist', () => {
  it('names the chip, the live terminal count and the app footprint', () => {
    expect(diagnosticsGist(snapshot())).toBe('arm64 · 12 terminals · 259 MiB')
  })

  it('sums every process, not only the ones the table shows', () => {
    expect(diagnosticsGist(snapshot({
      processes: [
        { pid: 1, type: 'Browser', cpuPercent: 0, memoryMb: 1024 },
        { pid: 2, type: 'Tab', cpuPercent: 0, memoryMb: 1024 },
      ],
    }))).toBe('arm64 · 12 terminals · 2.0 GiB')
  })

  it('says "translated" in the gist, because that is the one urgent fact', () => {
    expect(diagnosticsGist(snapshot({ translated: true })))
      .toBe('arm64 translated · 12 terminals · 259 MiB')
  })

  it('uses the singular for exactly one terminal', () => {
    expect(diagnosticsGist(snapshot({ livePtys: 1 }))).toContain('1 terminal ·')
  })

  it('drops the terminal count when the host cannot report it', () => {
    expect(diagnosticsGist(snapshot({ livePtys: null }))).toBe('arm64 · 259 MiB')
  })

  it('reports zero terminals rather than dropping the segment', () => {
    expect(diagnosticsGist(snapshot({ livePtys: 0 }))).toContain('0 terminals')
  })

  it('never returns an empty string, so the row always previews something', () => {
    expect(diagnosticsGist(snapshot({ livePtys: null, processes: [] })))
      .toBe('arm64 · 0 MiB')
  })
})

describe('diagnosticsDefaultExpanded', () => {
  it('is collapsed for a healthy machine with no stored preference', () => {
    expect(diagnosticsDefaultExpanded(snapshot(), null)).toBe(false)
  })

  it('honours a stored preference to keep it open', () => {
    expect(diagnosticsDefaultExpanded(snapshot(), 'true')).toBe(true)
  })

  it('honours a stored preference to keep it closed', () => {
    expect(diagnosticsDefaultExpanded(snapshot(), 'false')).toBe(false)
  })

  it('forces open on a translated build even when the user closed it', () => {
    expect(diagnosticsDefaultExpanded(snapshot({ translated: true }), 'false')).toBe(true)
  })

  it('forces open on a translated build before the preference has loaded', () => {
    expect(diagnosticsDefaultExpanded(snapshot({ translated: true }), null)).toBe(true)
  })

  it('stays collapsed while the snapshot is still loading', () => {
    expect(diagnosticsDefaultExpanded(null, null)).toBe(false)
    expect(diagnosticsDefaultExpanded(null, 'true')).toBe(true)
  })

  it('treats an unparseable stored value as no preference', () => {
    expect(diagnosticsDefaultExpanded(snapshot(), 'yes please')).toBe(false)
  })

  it('uses a namespaced settings key', () => {
    expect(DIAGNOSTICS_EXPANDED_SETTING_KEY).toBe('about.diagnosticsExpanded')
  })
})

/**
 * The Diagnostics disclosure renders COLLAPSED on first paint.
 *
 * `diagnostics-disclosure.test.ts` pins the rules; this pins that the
 * component actually obeys them, because the bug being prevented is visual:
 * a section that quietly renders open again.
 *
 * `renderToStaticMarkup` runs no effects, so this is the true first frame -
 * before the snapshot and the stored preference have loaded.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DiagnosticsSnapshot } from '../../src/shared/diagnostics-report'
import { DiagnosticsSection, DiagnosticsBody } from '../../src/renderer/components/SettingsModal'

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    appVersion: '0.8.58',
    arch: 'arm64',
    platform: 'darwin',
    osVersion: '26.6.2',
    translated: false,
    versions: { electron: '43.4.1', chrome: '150.0', node: '24.18.1' },
    uptimeSeconds: 10,
    memory: { totalMb: 8192, freeMb: 98 },
    processes: [{ pid: 1, type: 'Browser', cpuPercent: 0, memoryMb: 86 }],
    gpu: {},
    theme: 'dark',
    livePtys: 12,
    liveSessions: 14,
    logsDir: '/logs',
    ...overrides,
  }
}

describe('DiagnosticsSection first frame', () => {
  const html = renderToStaticMarkup(createElement(DiagnosticsSection))

  it('renders the disclosure collapsed', () => {
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('aria-expanded="true"')
  })

  it('collapses the body to zero height rather than unmounting it', () => {
    expect(html).toContain('grid-template-rows:0fr')
    expect(html).not.toContain('grid-template-rows:1fr')
  })

  it('takes the body out of the accessibility tree and the tab order while closed', () => {
    expect(html).toContain('inert')
  })

  it('points the header at the body it controls', () => {
    expect(html).toContain('aria-controls="sb-diagnostics-body"')
    expect(html).toContain('id="sb-diagnostics-body"')
  })

  it('still labels the section', () => {
    expect(html).toContain('Diagnostics')
  })

  it('shows a placeholder gist until the snapshot arrives', () => {
    expect(html).toContain('Collecting...')
  })

  it('does not render process rows before the snapshot arrives', () => {
    expect(html).not.toContain('Largest processes')
  })
})

describe('DiagnosticsBody', () => {
  const props = {
    error: null,
    feedback: null,
    buttonStyle: {},
    onCopy: () => {},
    onOpenLogs: () => {},
  }

  it('keeps both actions available once the snapshot is in', () => {
    const html = renderToStaticMarkup(createElement(DiagnosticsBody, { ...props, snapshot: snapshot() }))
    expect(html).toContain('Copy report')
    expect(html).toContain('Open logs folder')
    expect(html).toContain('Largest processes')
  })

  it('names the fix in the Chip row on a translated build', () => {
    const html = renderToStaticMarkup(createElement(DiagnosticsBody, { ...props, snapshot: snapshot({ translated: true }) }))
    expect(html).toContain('install the native build')
  })

  it('reports a collection failure instead of an empty panel', () => {
    const html = renderToStaticMarkup(createElement(DiagnosticsBody, { ...props, snapshot: null, error: 'boom' }))
    expect(html).toContain('Diagnostics unavailable: boom')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as recoveryModal from '../../src/renderer/components/sidebar/NativeSessionImportModal'
import type { SessionSummary } from '../../src/shared/types'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')
const modalSource = readFileSync(new URL('../../src/renderer/components/sidebar/NativeSessionImportModal.tsx', import.meta.url), 'utf8')

const candidates: SessionSummary[] = [
  {
    id: 'b58253b1-d3c4-42a3-aea2-917b7831168b',
    source: 'claude-code',
    title: 'v0',
    startedAt: 2,
    messageCount: 516,
    filePath: '/native/v0.jsonl',
    nativeRole: 'foreground',
  },
  {
    id: '019ff5ec-child',
    source: 'codex',
    title: 'Codex 45',
    startedAt: 1,
    messageCount: 0,
    filePath: '/native/child.jsonl',
    nativeRole: 'subagent',
    depth: 1,
  },
]

describe('NativeSessionImportModal', () => {
  it('renders as a bounded, searchable and dismissible modal', () => {
    const markup = renderToStaticMarkup(createElement(recoveryModal.NativeSessionImportModal, {
      projectName: 'GEOIQ-LK-PANEL-AGENT-IN',
      candidates,
      importingId: null,
      error: null,
      onImport: () => {},
      onClose: () => {},
    }))

    expect(markup).toContain('class="recovery-modal-overlay"')
    expect(markup).toContain('class="recovery-modal-content')
    expect(markup).toContain('class="recovery-modal-results"')
    expect(markup).toContain('placeholder="Search 2 transcripts')
    expect(markup).toContain('aria-label="Close recovery inventory"')
    expect(markup).toContain('2 transcripts')
  })

  it('exposes a filter that finds title, provider, role and full native id', () => {
    const filter = recoveryModal.filterRecoveryCandidates
    expect(filter(candidates, 'v0').map((item) => item.id)).toEqual([candidates[0].id])
    expect(filter(candidates, 'claude').map((item) => item.id)).toEqual([candidates[0].id])
    expect(filter(candidates, 'subagent').map((item) => item.id)).toEqual([candidates[1].id])
    expect(filter(candidates, 'b58253b1-d3c4').map((item) => item.id)).toEqual([candidates[0].id])
  })

  it('has viewport and result-list overflow contracts', () => {
    expect(css).toMatch(/\.recovery-modal-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s)
    expect(css).toMatch(/\.recovery-modal-content\s*\{[^}]*max-height:[^}]*display:\s*flex[^}]*flex-direction:\s*column/s)
    expect(css).toMatch(/\.recovery-modal-results\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s)
  })

  it('traps keyboard focus and restores the recovery trigger on close', () => {
    expect(modalSource).toMatch(/const dialogRef = useRef/)
    expect(modalSource).toMatch(/event\.key !== 'Tab'/)
    expect(modalSource).toMatch(/previous\?\.focus\(\)/)
  })
})

/**
 * Every stored system row's phone rendering. The same fixture runs against
 * Android's port (SystemMarkersFixturesTest.kt), so the two phones agree.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { peerUndeliveredReasonText, systemRowView, type SystemRowView } from '../../src/shared/system-markers'
import { formatUndeliveredMarker } from '../../src/shared/peer-links'

const here = dirname(fileURLToPath(import.meta.url))
const cases: Array<{ id: string; content: string; expected: SystemRowView }> = JSON.parse(
  readFileSync(resolve(here, '../fixtures/system-marker-cases.json'), 'utf8'),
)

describe('systemRowView', () => {
  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(systemRowView(c.content)).toEqual(c.expected)
  })

  it('reads what the backend writes', () => {
    const row = { to: 'a', toLabel: 'B', reason: 'link-budget' as const, text: 'x', sent: false }
    expect(systemRowView(formatUndeliveredMarker(row))).toEqual({ kind: 'peer-undelivered', row })
  })

  it('names every refusal reason', () => {
    const row = { to: 'a', toLabel: 'B', text: 'x', sent: false }
    expect(peerUndeliveredReasonText({ ...row, reason: 'link-expired' })).toBe("The link's time ran out.")
    expect(peerUndeliveredReasonText({ ...row, reason: 'link-budget' })).toBe("The link's message budget was spent.")
    expect(peerUndeliveredReasonText({ ...row, reason: 'link-removed' })).toBe(
      'The link was removed before it was sent.',
    )
  })
})

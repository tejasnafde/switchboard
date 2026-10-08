import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VISUAL_HOST_OUT, visualHostInputHash } from '../../scripts/build-visual-host.mjs'

describe('the phones\' visual host page', () => {
  const html = readFileSync(VISUAL_HOST_OUT, 'utf8')

  it('is built from the current sources (rerun node scripts/build-visual-host.mjs)', () => {
    expect(html.slice(0, 200)).toContain(`visual-host ${visualHostInputHash()}`)
  })

  it('allows nothing outside the page', () => {
    expect(html).toContain("default-src 'none'")
  })
})

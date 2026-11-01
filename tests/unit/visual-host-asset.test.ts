import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LIVE_LIBS,
  LIVE_LIBS_OUT,
  LIVE_LIBS_SOURCE,
  VISUAL_HOST_OUT,
  visualHostInputHash,
} from '../../scripts/build-visual-host.mjs'
import { HTML_LIVE_LIBRARIES } from '../../src/shared/html-live'

describe("the phones' visual host page", () => {
  const html = readFileSync(VISUAL_HOST_OUT, 'utf8')

  it('is built from the current sources (rerun node scripts/build-visual-host.mjs)', () => {
    expect(html.slice(0, 200)).toContain(`visual-host ${visualHostInputHash()}`)
  })

  it('allows nothing outside the page', () => {
    expect(html).toContain("default-src 'none'")
  })
})

describe("the Expo app's live page libraries", () => {
  it('copies every library the phones ship, byte for byte (rerun node scripts/build-visual-host.mjs)', () => {
    // Mermaid stays on the desktop: a live page that loads it shows its still image on a phone.
    const shipped = HTML_LIVE_LIBRARIES.map((lib) => lib.path).filter((path) => path !== 'mermaid.js')
    expect(Object.keys(LIVE_LIBS).sort()).toEqual(shipped.sort())
    expect(readdirSync(LIVE_LIBS_OUT).sort()).toEqual(Object.values(LIVE_LIBS).sort())
    for (const [path, name] of Object.entries(LIVE_LIBS)) {
      const copy = readFileSync(join(LIVE_LIBS_OUT, name))
      expect(copy.equals(readFileSync(join(LIVE_LIBS_SOURCE, ...path.split('/')))), name).toBe(true)
    }
  })
})

/** The vendored /_sb/ libraries are the npm files resources/sb-live/README.md names, unmodified. */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HTML_LIVE_LIBRARIES } from '../../src/shared/html-live'

const ROOT = join(process.cwd(), 'resources', 'sb-live')

const SHA256: Record<string, string> = {
  'chart.js': '48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a',
  'd3.js': 'f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539',
  'three.js': '08fd7545d13d2c7fb65ab691530a802dafefd638596501854f267d0fb13c39e7',
  'three/addons/controls/OrbitControls.js': '80efaadea4f8a636a65fb0bd08bfef62f3d93a0bb94e2e7500f23176c5c07f4e',
}

describe('bundled live page libraries', () => {
  it('ships every library the shared list names, with its checksum and licence', () => {
    for (const { path } of HTML_LIVE_LIBRARIES) {
      if (path === 'mermaid.js') {
        // The app's own dependency, not vendored.
        expect(existsSync(join(process.cwd(), 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'))).toBe(true)
        continue
      }
      const bytes = readFileSync(join(ROOT, ...path.split('/')))
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(SHA256[path])
    }
    for (const licence of ['chart.js-LICENSE.md', 'd3-LICENSE', 'three-LICENSE']) {
      expect(existsSync(join(ROOT, 'licenses', licence)), licence).toBe(true)
    }
  })
})

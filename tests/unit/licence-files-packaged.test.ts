import { existsSync, readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const LICENCE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md']

type FileSet = { from?: string; to?: string }
type BuilderConfig = { extends?: string; extraResources?: FileSet[] }

// electron-builder resolves `extends` by appending the child's arrays to the
// parent's, so a config's effective extraResources are its own plus every
// ancestor's.
function effectiveExtraResources(path: string): FileSet[] {
  const config = load(readFileSync(path, 'utf8')) as BuilderConfig
  const inherited = config.extends ? effectiveExtraResources(config.extends) : []
  return [...inherited, ...(config.extraResources ?? [])]
}

describe('packaged licence files', () => {
  for (const config of ['electron-builder.yml', 'electron-builder.signed.yml']) {
    it(`${config} copies the licence files into Resources`, () => {
      const resources = effectiveExtraResources(config)
      for (const file of LICENCE_FILES) {
        expect(resources).toContainEqual({ from: file, to: file })
      }
    })
  }

  it('keeps the licence files at the repo root', () => {
    for (const file of LICENCE_FILES) expect(existsSync(file)).toBe(true)
  })
})

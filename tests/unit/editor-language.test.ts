/**
 * Pure ext → language-id mapping for the CM6 editor. The language-pack
 * loader (which dynamic-imports `@codemirror/lang-*`) is wired separately;
 * this module is just the lookup table. Keeping it pure means the editor
 * extensions composer can be unit-tested without spinning up a DOM.
 */
import { describe, expect, it } from 'vitest'
import { languageIdForPath } from '../../src/renderer/components/files/editor/extensions/language'

describe('languageIdForPath', () => {
  it('maps TypeScript / JavaScript family extensions', () => {
    expect(languageIdForPath('foo.ts')).toBe('typescript')
    expect(languageIdForPath('foo.tsx')).toBe('typescript')
    expect(languageIdForPath('foo.js')).toBe('javascript')
    expect(languageIdForPath('foo.jsx')).toBe('javascript')
    expect(languageIdForPath('foo.mjs')).toBe('javascript')
    expect(languageIdForPath('foo.cjs')).toBe('javascript')
  })

  it('maps Python / Rust / Go', () => {
    expect(languageIdForPath('foo.py')).toBe('python')
    expect(languageIdForPath('foo.rs')).toBe('rust')
    expect(languageIdForPath('foo.go')).toBe('go')
  })

  it('maps web languages', () => {
    expect(languageIdForPath('foo.css')).toBe('css')
    expect(languageIdForPath('foo.html')).toBe('html')
    expect(languageIdForPath('foo.json')).toBe('json')
    expect(languageIdForPath('foo.yaml')).toBe('yaml')
    expect(languageIdForPath('foo.yml')).toBe('yaml')
    expect(languageIdForPath('foo.md')).toBe('markdown')
  })

  it('handles uppercase extensions', () => {
    expect(languageIdForPath('FOO.TS')).toBe('typescript')
    expect(languageIdForPath('FOO.PY')).toBe('python')
  })

  it('handles paths with directory separators', () => {
    expect(languageIdForPath('src/main/index.ts')).toBe('typescript')
    expect(languageIdForPath('C:\\Users\\me\\foo.py')).toBe('python')
  })

  it('returns null for unknown / extensionless files', () => {
    expect(languageIdForPath('Makefile')).toBeNull()
    expect(languageIdForPath('foo.unknownext')).toBeNull()
    expect(languageIdForPath('')).toBeNull()
  })
})

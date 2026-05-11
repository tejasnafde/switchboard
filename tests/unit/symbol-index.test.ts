/**
 * In-memory symbol index. The actual tree-sitter parsing lives behind
 * an init shim (loaded lazily when grammars are bundled); the lookup
 * layer tested here is pure: addDefinitions/findDefinition/removeFile.
 *
 * Tests:
 *   - empty index returns no definitions
 *   - addDefinitions adds entries; lookup by symbol name returns them
 *   - removeFile drops everything sourced from that file
 *   - same symbol in two files returns both definitions
 *   - outline returns per-file def list in source order
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  addDefinitions,
  findDefinitions,
  outline,
  removeFile,
  resetSymbolIndex,
} from '../../src/renderer/services/symbolIndex'

beforeEach(() => {
  resetSymbolIndex()
})

describe('symbolIndex', () => {
  it('returns empty array for unknown symbol', () => {
    expect(findDefinitions('foo')).toEqual([])
  })

  it('addDefinitions stores entries; findDefinitions returns them', () => {
    addDefinitions('/r/a.ts', [
      { name: 'foo', kind: 'function', line: 5, ch: 0 },
      { name: 'bar', kind: 'class', line: 10, ch: 6 },
    ])
    expect(findDefinitions('foo')).toEqual([
      { path: '/r/a.ts', name: 'foo', kind: 'function', line: 5, ch: 0 },
    ])
    expect(findDefinitions('bar')).toEqual([
      { path: '/r/a.ts', name: 'bar', kind: 'class', line: 10, ch: 6 },
    ])
  })

  it('returns definitions from multiple files for the same symbol', () => {
    addDefinitions('/r/a.ts', [{ name: 'foo', kind: 'function', line: 1, ch: 0 }])
    addDefinitions('/r/b.ts', [{ name: 'foo', kind: 'function', line: 5, ch: 0 }])
    const found = findDefinitions('foo')
    expect(found).toHaveLength(2)
    expect(found.map((d) => d.path).sort()).toEqual(['/r/a.ts', '/r/b.ts'])
  })

  it('removeFile drops only that file’s entries', () => {
    addDefinitions('/r/a.ts', [{ name: 'foo', kind: 'function', line: 1, ch: 0 }])
    addDefinitions('/r/b.ts', [{ name: 'foo', kind: 'function', line: 5, ch: 0 }])
    removeFile('/r/a.ts')
    expect(findDefinitions('foo')).toEqual([
      { path: '/r/b.ts', name: 'foo', kind: 'function', line: 5, ch: 0 },
    ])
  })

  it('addDefinitions overwrites the prior entries for that file (re-index on save)', () => {
    addDefinitions('/r/a.ts', [{ name: 'old', kind: 'function', line: 1, ch: 0 }])
    addDefinitions('/r/a.ts', [{ name: 'new', kind: 'function', line: 2, ch: 0 }])
    expect(findDefinitions('old')).toEqual([])
    expect(findDefinitions('new')).toHaveLength(1)
  })

  it('outline returns definitions for a single file in source order', () => {
    addDefinitions('/r/a.ts', [
      { name: 'a', kind: 'function', line: 5, ch: 0 },
      { name: 'b', kind: 'class', line: 1, ch: 0 },
      { name: 'c', kind: 'function', line: 20, ch: 0 },
    ])
    const out = outline('/r/a.ts')
    expect(out.map((s) => s.name)).toEqual(['b', 'a', 'c'])
  })
})

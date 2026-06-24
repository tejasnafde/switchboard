/**
 * git-grep symbol fallback: pattern construction + output parsing.
 */
import { describe, it, expect } from 'vitest'
import { declarationPattern, parseGitGrep } from '../../src/main/files/grep'

describe('declarationPattern', () => {
  it('matches common declaration keywords followed by the symbol', () => {
    const p = declarationPattern('foo')
    expect(p).toContain('foo')
    expect(p).toMatch(/function\|const/)
  })
})

describe('parseGitGrep', () => {
  it('parses path:line:text into hits with the symbol column', () => {
    const out = parseGitGrep('src/a.ts:12:export function foo() {}\nsrc/b.ts:3:const foo = 1', 'foo')
    expect(out).toEqual([
      { relPath: 'src/a.ts', line: 12, ch: 'export function '.length },
      { relPath: 'src/b.ts', line: 3, ch: 'const '.length },
    ])
  })

  it('falls back to ch=0 when the symbol is not found in the text', () => {
    const out = parseGitGrep('a.ts:5:something else', 'foo')
    expect(out[0]).toEqual({ relPath: 'a.ts', line: 5, ch: 0 })
  })

  it('skips blank / malformed lines and respects the cap', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `f${i}.ts:1:const foo = ${i}`).join('\n')
    const out = parseGitGrep(`\n${lines}\nnot-a-grep-line`, 'foo', 5)
    expect(out).toHaveLength(5)
  })
})

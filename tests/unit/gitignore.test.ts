/**
 * Pure gitignore matching for the file tree pane. We *annotate* — never
 * filter — so users can still see and click `node_modules/` etc., just
 * rendered greyed-out (VS Code-style).
 *
 * Implementation kept tiny: handles the patterns common in JS/Python repos:
 *   - bare names (`node_modules`, `dist`)
 *   - leading-slash anchored (`/build`)
 *   - trailing-slash directory-only (`logs/`)
 *   - glob `*` and `?`
 *   - `!` negation
 *   - blank lines + `#` comments ignored
 *
 * Doesn't aim for full git semantics (no nested .gitignore composition, no
 * `**` recursion subtleties). Good enough for the visual cue.
 */
import { describe, it, expect } from 'vitest'
import { parseGitignore, isIgnored } from '../../src/main/files/gitignore'

describe('parseGitignore', () => {
  it('returns empty rules for empty input', () => {
    expect(parseGitignore('')).toEqual([])
    expect(parseGitignore('   \n\n')).toEqual([])
  })

  it('strips comments and blank lines', () => {
    const out = parseGitignore('# comment\n\nnode_modules\n# another\n')
    expect(out).toHaveLength(1)
    expect(out[0].pattern).toBe('node_modules')
  })

  it('flags negation rules', () => {
    const out = parseGitignore('*.log\n!keep.log\n')
    expect(out[1].negate).toBe(true)
    expect(out[1].pattern).toBe('keep.log')
  })
})

describe('isIgnored', () => {
  it('matches bare names anywhere in the tree', () => {
    const rules = parseGitignore('node_modules\n')
    expect(isIgnored('node_modules', true, rules)).toBe(true)
    expect(isIgnored('src/node_modules', true, rules)).toBe(true)
    expect(isIgnored('src', true, rules)).toBe(false)
  })

  it('respects trailing slash (directories only)', () => {
    const rules = parseGitignore('logs/\n')
    expect(isIgnored('logs', true, rules)).toBe(true)
    expect(isIgnored('logs', false, rules)).toBe(false) // file named "logs" not ignored
  })

  it('respects leading slash (anchored to root)', () => {
    const rules = parseGitignore('/build\n')
    expect(isIgnored('build', true, rules)).toBe(true)
    expect(isIgnored('src/build', true, rules)).toBe(false)
  })

  it('handles glob wildcards', () => {
    const rules = parseGitignore('*.log\n')
    expect(isIgnored('error.log', false, rules)).toBe(true)
    expect(isIgnored('src/debug.log', false, rules)).toBe(true)
    expect(isIgnored('error.txt', false, rules)).toBe(false)
  })

  it('honors negation (later rule wins)', () => {
    const rules = parseGitignore('*.log\n!keep.log\n')
    expect(isIgnored('keep.log', false, rules)).toBe(false)
    expect(isIgnored('error.log', false, rules)).toBe(true)
  })

  it('does not throw on weird input', () => {
    const rules = parseGitignore('***\n[\n')
    expect(() => isIgnored('foo', false, rules)).not.toThrow()
  })

  it('supports ** matching across directory segments (E7)', () => {
    const leading = parseGitignore('**/.DS_Store\n')
    expect(isIgnored('.DS_Store', false, leading)).toBe(true)
    expect(isIgnored('a/.DS_Store', false, leading)).toBe(true)
    expect(isIgnored('a/b/.DS_Store', false, leading)).toBe(true)
    expect(isIgnored('a/keep.txt', false, leading)).toBe(false)

    const trailing = parseGitignore('dist/**\n')
    expect(isIgnored('dist/bundle.js', false, trailing)).toBe(true)
    expect(isIgnored('dist/sub/bundle.js', false, trailing)).toBe(true)
    expect(isIgnored('dist', true, trailing)).toBe(false) // dir itself, no children
    expect(isIgnored('other/bundle.js', false, trailing)).toBe(false)
  })

  it('matches case-insensitively to mirror git core.ignorecase on macOS/Windows (E8)', () => {
    const rules = parseGitignore('node_modules\n*.LOG\n')
    expect(isIgnored('Node_Modules', true, rules)).toBe(true)
    expect(isIgnored('error.log', false, rules)).toBe(true)
  })

  it('treats a pattern containing a slash as anchored to root', () => {
    // Per gitignore semantics, a slash in the middle of a pattern anchors it
    // to the repo root — `foo/bar` matches `foo/bar` but NOT `a/foo/bar`.
    const rules = parseGitignore('foo/bar\n')
    expect(isIgnored('foo/bar', true, rules)).toBe(true)
    expect(isIgnored('a/foo/bar', true, rules)).toBe(false)
  })
})

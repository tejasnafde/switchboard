/**
 * Pure parser + authorization for the `sb-favicon://` Electron protocol.
 * The actual `protocol.handle` callback is a thin adapter over these
 * functions — keeping them pure means we can test the security posture
 * without spinning up Electron.
 *
 * URL shape:  `sb-favicon://favicon?path=<percent-encoded-absolute-path>`
 *   - hostname is fixed to `favicon` so `new URL(...)` always parses
 *   - the absolute project path is carried in the `path` query param
 *
 * Security: parseFaviconUrl returns the path as-is; isAuthorizedProjectPath
 * is the containment check — the path must exactly match one of the
 * registered projects. We never serve favicons from arbitrary disk
 * locations the renderer asks for.
 */
import { describe, expect, it } from 'vitest'
import {
  parseFaviconUrl,
  isAuthorizedProjectPath,
} from '../../src/main/protocol/sb-favicon'

describe('parseFaviconUrl', () => {
  it('extracts an absolute path from a well-formed sb-favicon URL', () => {
    const encoded = encodeURIComponent('/Users/me/projects/foo')
    const out = parseFaviconUrl(`sb-favicon://favicon?path=${encoded}`)
    expect(out).toEqual({ projectPath: '/Users/me/projects/foo' })
  })

  it('handles Windows-style absolute paths with backslashes', () => {
    const encoded = encodeURIComponent('C:\\Users\\me\\projects\\foo')
    const out = parseFaviconUrl(`sb-favicon://favicon?path=${encoded}`)
    expect(out).toEqual({ projectPath: 'C:\\Users\\me\\projects\\foo' })
  })

  it('returns null when the path query param is missing', () => {
    expect(parseFaviconUrl('sb-favicon://favicon')).toBeNull()
    expect(parseFaviconUrl('sb-favicon://favicon?other=x')).toBeNull()
  })

  it('returns null when the path query param is empty', () => {
    expect(parseFaviconUrl('sb-favicon://favicon?path=')).toBeNull()
  })

  it('returns null when the URL is wrong scheme', () => {
    expect(parseFaviconUrl('http://favicon?path=/foo')).toBeNull()
  })

  it('returns null on garbage input that does not parse as a URL', () => {
    expect(parseFaviconUrl('not a url')).toBeNull()
  })
})

describe('isAuthorizedProjectPath', () => {
  const known = ['/Users/me/projects/foo', '/Users/me/projects/bar', 'C:\\src\\baz']

  it('accepts an exact match against the known-projects list', () => {
    expect(isAuthorizedProjectPath('/Users/me/projects/foo', known)).toBe(true)
    expect(isAuthorizedProjectPath('C:\\src\\baz', known)).toBe(true)
  })

  it('rejects paths not in the known list', () => {
    expect(isAuthorizedProjectPath('/Users/me/projects/other', known)).toBe(false)
    expect(isAuthorizedProjectPath('/etc/passwd', known)).toBe(false)
  })

  it('rejects subpaths of a known project (only the project root is authorized)', () => {
    // Even if /Users/me/projects/foo is known, /Users/me/projects/foo/secret
    // is a *different* path — favicon resolver only ever looks at probes
    // under the project root, so anything else is a bug or attack.
    expect(isAuthorizedProjectPath('/Users/me/projects/foo/.env', known)).toBe(false)
  })

  it('rejects parent paths (containment is exact, not prefix)', () => {
    expect(isAuthorizedProjectPath('/Users/me/projects', known)).toBe(false)
    expect(isAuthorizedProjectPath('/', known)).toBe(false)
  })

  it('rejects when the known list is empty', () => {
    expect(isAuthorizedProjectPath('/anything', [])).toBe(false)
  })
})

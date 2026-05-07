/**
 * The HTML-fallback path of favicon detection: when no static probe
 * matches, scan a small set of candidate HTML / framework root files for
 * `<link rel="icon" href="...">`, resolve the href against the file, and
 * return the result if the resolved path lives inside the project.
 *
 * Two tested layers:
 *   - findFaviconHrefInHtml: pure parser (string -> href | null)
 *   - resolveFaviconViaHtml:  walks candidate files, applies the parser,
 *     and validates the resolved path is inside the project (rejects
 *     `../../etc/passwd` style traversal attempts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findFaviconHrefInHtml,
  resolveFaviconViaHtml,
} from '../../src/main/projects/faviconHtmlScan'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sb-favicon-html-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function touch(rel: string, content: string): string {
  const abs = join(tmp, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

describe('findFaviconHrefInHtml', () => {
  it('returns null when no link tag is present', () => {
    expect(findFaviconHrefInHtml('<html><body>hi</body></html>')).toBeNull()
  })

  it('extracts href from a double-quoted icon link', () => {
    const html = '<link rel="icon" href="/favicon.svg">'
    expect(findFaviconHrefInHtml(html)).toBe('/favicon.svg')
  })

  it('extracts href from a single-quoted icon link', () => {
    const html = "<link rel='icon' href='/favicon.svg'>"
    expect(findFaviconHrefInHtml(html)).toBe('/favicon.svg')
  })

  it('also matches rel="shortcut icon"', () => {
    const html = '<link rel="shortcut icon" href="/static/fav.png">'
    expect(findFaviconHrefInHtml(html)).toBe('/static/fav.png')
  })

  it('skips data: URLs (we only want on-disk files)', () => {
    const html = '<link rel="icon" href="data:image/svg+xml;base64,PHN2Zy8+">'
    expect(findFaviconHrefInHtml(html)).toBeNull()
  })

  it('skips http(s) URLs (cannot serve a remote URL from sb-favicon://)', () => {
    const html = '<link rel="icon" href="https://example.com/fav.ico">'
    expect(findFaviconHrefInHtml(html)).toBeNull()
  })

  it('handles attribute-order swap (href before rel)', () => {
    const html = '<link href="/favicon.svg" rel="icon">'
    expect(findFaviconHrefInHtml(html)).toBe('/favicon.svg')
  })

  it('returns the first valid icon link when multiple are present', () => {
    const html = `
      <link rel="stylesheet" href="/style.css">
      <link rel="icon" href="/favicon.svg">
      <link rel="icon" href="/other.png">
    `
    expect(findFaviconHrefInHtml(html)).toBe('/favicon.svg')
  })
})

describe('resolveFaviconViaHtml', () => {
  it('resolves href relative to the HTML file when href is relative', async () => {
    const fav = touch('public/icon.svg', '<svg/>')
    touch('public/index.html', '<link rel="icon" href="./icon.svg">')
    const result = await resolveFaviconViaHtml(tmp)
    expect(result?.absPath).toBe(fav)
    expect(result?.mime).toBe('image/svg+xml')
  })

  it('treats a leading-slash href as project-root-relative', async () => {
    const fav = touch('favicon.svg', '<svg/>')
    touch('index.html', '<link rel="icon" href="/favicon.svg">')
    const result = await resolveFaviconViaHtml(tmp)
    expect(result?.absPath).toBe(fav)
  })

  it('walks the candidate file list in priority order', async () => {
    // index.html is first in the list — should win even if app/root.tsx
    // also has a favicon link.
    const winner = touch('favicon.svg', '<svg/>')
    touch('app/icon.svg', '<svg/>')
    touch('index.html', '<link rel="icon" href="/favicon.svg">')
    touch('app/root.tsx', '<link rel="icon" href="./icon.svg">')
    const result = await resolveFaviconViaHtml(tmp)
    expect(result?.absPath).toBe(winner)
  })

  it('rejects href that escapes the project root via ../', async () => {
    // Attempt: index.html says <link rel="icon" href="../../../etc/passwd">.
    // Must NOT return that path, even if it resolves to a real file.
    touch('index.html', '<link rel="icon" href="../../../etc/passwd">')
    const result = await resolveFaviconViaHtml(tmp)
    expect(result).toBeNull()
  })

  it('returns null when no candidate file contains a usable icon link', async () => {
    touch('index.html', '<html><body>hi</body></html>')
    const result = await resolveFaviconViaHtml(tmp)
    expect(result).toBeNull()
  })

  it('returns null when no candidate HTML files exist at all', async () => {
    const result = await resolveFaviconViaHtml(tmp)
    expect(result).toBeNull()
  })

  it('returns null when the link href points to a file that does not exist on disk', async () => {
    touch('index.html', '<link rel="icon" href="/missing-favicon.svg">')
    const result = await resolveFaviconViaHtml(tmp)
    expect(result).toBeNull()
  })
})

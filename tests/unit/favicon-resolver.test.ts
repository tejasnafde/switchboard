/**
 * Auto-detect a project's favicon for the sidebar leading icon. Mirrors
 * t3code's ProjectFaviconResolver probe order — root, public/, app/, src/,
 * assets/, .idea/ — and falls back to scanning HTML `<link rel="icon">`
 * tags. Cross-platform: paths join via node:path, no hardcoded separators.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  resolveProjectFavicon,
  __clearFaviconCacheForTests,
} from '../../src/main/projects/faviconResolver'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sb-favicon-'))
  __clearFaviconCacheForTests()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** Create a file at `<tmp>/<rel>`, creating parent dirs as needed. */
function touch(rel: string, content = ''): string {
  const abs = join(tmp, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

describe('resolveProjectFavicon — probe order', () => {
  it('returns null when no favicon exists anywhere in the project', async () => {
    const result = await resolveProjectFavicon(tmp)
    expect(result).toBeNull()
  })

  it('finds favicon.svg at project root', async () => {
    const abs = touch('favicon.svg', '<svg/>')
    const result = await resolveProjectFavicon(tmp)
    expect(result).not.toBeNull()
    expect(result!.absPath).toBe(abs)
    expect(result!.mime).toBe('image/svg+xml')
  })

  it('prefers root favicon.svg over public/favicon.svg', async () => {
    const root = touch('favicon.svg', '<svg/>')
    touch('public/favicon.svg', '<svg/>')
    const result = await resolveProjectFavicon(tmp)
    expect(result!.absPath).toBe(root)
  })

  it('falls through to public/favicon.svg when root is missing', async () => {
    const pub = touch('public/favicon.svg', '<svg/>')
    const result = await resolveProjectFavicon(tmp)
    expect(result!.absPath).toBe(pub)
  })

  it('falls through to app/icon.svg when root + public are missing', async () => {
    const app = touch('app/icon.svg', '<svg/>')
    const result = await resolveProjectFavicon(tmp)
    expect(result!.absPath).toBe(app)
  })

  it('finds .idea/icon.svg as the lowest-priority static probe', async () => {
    const idea = touch('.idea/icon.svg', '<svg/>')
    const result = await resolveProjectFavicon(tmp)
    expect(result!.absPath).toBe(idea)
  })
})

describe('resolveProjectFavicon — MIME detection', () => {
  it('maps .svg to image/svg+xml', async () => {
    touch('favicon.svg', '<svg/>')
    const r = await resolveProjectFavicon(tmp)
    expect(r!.mime).toBe('image/svg+xml')
  })

  it('maps .ico to image/x-icon', async () => {
    // ICO header bytes — content irrelevant to MIME mapping (extension-driven).
    touch('favicon.ico', '\x00\x00\x01\x00')
    const r = await resolveProjectFavicon(tmp)
    expect(r!.mime).toBe('image/x-icon')
  })

  it('maps .png to image/png', async () => {
    touch('favicon.png', '')
    const r = await resolveProjectFavicon(tmp)
    expect(r!.mime).toBe('image/png')
  })
})

describe('resolveProjectFavicon — HTML fallback chain', () => {
  it('falls through to <link rel=icon> scan when no static probe matches', async () => {
    // No favicon at any of the well-known probe paths, but index.html
    // points to one in a non-standard location.
    const fav = touch('static/site-icon.svg', '<svg/>')
    touch('index.html', '<link rel="icon" href="./static/site-icon.svg">')
    const result = await resolveProjectFavicon(tmp)
    expect(result?.absPath).toBe(fav)
    expect(result?.mime).toBe('image/svg+xml')
  })
})

describe('resolveProjectFavicon — caching', () => {
  it('caches the result so a second call does not re-probe (returns same object identity)', async () => {
    touch('favicon.svg', '<svg/>')
    const first = await resolveProjectFavicon(tmp)
    const second = await resolveProjectFavicon(tmp)
    // Same shape; identity check on cache hit
    expect(second).toBe(first)
  })

  it('invalidates cache when project root mtime changes', async () => {
    touch('favicon.svg', '<svg/>')
    const first = await resolveProjectFavicon(tmp)

    // Bump root mtime forward by 5 seconds — simulates a file add/remove
    // inside the project (which always bumps the parent dir mtime).
    const stat = statSync(tmp)
    const future = new Date(stat.mtimeMs + 5_000)
    utimesSync(tmp, future, future)

    const second = await resolveProjectFavicon(tmp)
    // Cache miss — fresh probe returns a new object
    expect(second).not.toBe(first)
    // ...but the result is still the same favicon
    expect(second!.absPath).toBe(first!.absPath)
  })
})

/**
 * Auto-detect a project's favicon and return its absolute path + MIME so the
 * sidebar can render the project's own logo as its leading icon (vs. a
 * generic folder). Mirrors t3code's ProjectFaviconResolver:
 *
 *   1. Probe a fixed list of well-known paths in priority order
 *      (root → public/ → app/ → src/ → assets/ → .idea/).
 *   2. If nothing matches, fall back to scanning a few candidate HTML
 *      files for `<link rel="icon" href="...">` (handled in
 *      faviconHtmlScan.ts, wired below).
 *
 * Cache: keyed by absolute project path + parent dir mtime, so a file
 * add/remove inside the project (which always bumps the parent mtime)
 * naturally invalidates the cached probe result. Same pattern we use in
 * `getCachedGitignore` (src/main/files/listing.ts).
 *
 * Cross-platform: every probe path is built with `path.join` so Windows
 * separators just work. We never embed `/` literals in probe strings.
 */
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { resolveFaviconViaHtml } from './faviconHtmlScan'

export interface FaviconResult {
  /** Absolute path to the favicon file on disk. */
  absPath: string
  /** Content-Type for HTTP / Electron protocol responses. */
  mime: string
}

/**
 * Static probe list — same paths as t3code's ProjectFaviconResolver.ts:9–31,
 * stored as path *segments* (not slash-joined strings) so we can `join(...)`
 * them onto the project root and get correct separators on every OS.
 */
const PROBE_SEGMENTS: ReadonlyArray<readonly string[]> = [
  // Root
  ['favicon.svg'],
  ['favicon.ico'],
  ['favicon.png'],
  // public/
  ['public', 'favicon.svg'],
  ['public', 'favicon.ico'],
  ['public', 'favicon.png'],
  // app/
  ['app', 'favicon.ico'],
  ['app', 'favicon.png'],
  ['app', 'icon.svg'],
  ['app', 'icon.png'],
  ['app', 'icon.ico'],
  // src/
  ['src', 'favicon.ico'],
  ['src', 'favicon.svg'],
  ['src', 'app', 'favicon.ico'],
  ['src', 'app', 'icon.svg'],
  ['src', 'app', 'icon.png'],
  // assets/
  ['assets', 'icon.svg'],
  ['assets', 'icon.png'],
  ['assets', 'logo.svg'],
  ['assets', 'logo.png'],
  // JetBrains-style
  ['.idea', 'icon.svg'],
]

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
}

function mimeFor(absPath: string): string {
  return MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
}

interface CacheEntry {
  rootMtimeMs: number
  result: FaviconResult | null
}
const cache = new Map<string, CacheEntry>()

/** Test hook — wipe the module-level cache between tests. */
export function __clearFaviconCacheForTests(): void {
  cache.clear()
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs)
    return st.isFile()
  } catch {
    return false
  }
}

async function probeStaticPaths(projectPath: string): Promise<FaviconResult | null> {
  for (const segments of PROBE_SEGMENTS) {
    const abs = join(projectPath, ...segments)
    if (await fileExists(abs)) {
      return { absPath: abs, mime: mimeFor(abs) }
    }
  }
  return null
}

export async function resolveProjectFavicon(projectPath: string): Promise<FaviconResult | null> {
  // Stat the project root so we can key the cache on its mtime. If the
  // project itself doesn't exist or isn't readable, bail out null —
  // caller will render the fallback folder icon.
  let rootMtimeMs: number
  try {
    const st = await fs.stat(projectPath)
    if (!st.isDirectory()) return null
    rootMtimeMs = st.mtimeMs
  } catch {
    return null
  }

  const cached = cache.get(projectPath)
  if (cached && cached.rootMtimeMs === rootMtimeMs) {
    return cached.result
  }

  // Static probe first — fast, no I/O beyond a stat per candidate path.
  // If nothing matches, fall through to the HTML link-tag scan.
  const result =
    (await probeStaticPaths(projectPath)) ?? (await resolveFaviconViaHtml(projectPath))
  cache.set(projectPath, { rootMtimeMs, result })
  return result
}

/**
 * HTML fallback for favicon detection. When no static probe path matches
 * (see faviconResolver.ts), we scan a handful of candidate HTML / SPA-root
 * files for a `<link rel="icon" href="...">` tag, resolve the href against
 * the file's directory, and return the result *if* the resolved path is
 * still inside the project root. Anything escaping (../../etc/passwd) is
 * rejected — same posture as path-access.ts.
 *
 * Two functions:
 *   - findFaviconHrefInHtml(html): pure regex-based parser. Doesn't know
 *     about the filesystem. Returns the raw href string or null. We skip
 *     `data:`/`http(s):` URLs since sb-favicon:// can only serve on-disk
 *     files.
 *   - resolveFaviconViaHtml(projectPath): walks CANDIDATE_HTML_FILES in
 *     order, applies the parser, resolves the href, and validates the
 *     result is contained in projectPath. First valid hit wins.
 *
 * Cross-platform: every path join goes through node:path; we never embed
 * `/` literals when constructing on-disk paths. Hrefs from HTML are
 * intentionally kept as POSIX-style strings (since that's how authors write
 * them in href attributes) and only resolved at the end.
 */
import { promises as fs } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FaviconResult } from './faviconResolver'

// Re-export so existing callers (incl. tests) of FaviconResult-shaped
// objects don't have to know which file the type lives in.
export type { FaviconResult }

/** Candidate files to scan, in priority order (matches t3code's list). */
const CANDIDATE_HTML_FILES: ReadonlyArray<readonly string[]> = [
  ['index.html'],
  ['public', 'index.html'],
  ['app', 'routes', '__root.tsx'],
  ['src', 'routes', '__root.tsx'],
  ['app', 'root.tsx'],
  ['src', 'root.tsx'],
]

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function mimeFor(absPath: string): string {
  return MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Match `<link ... rel="...icon..." ... href="...">` regardless of attribute
 * order or quote style. Returns the first usable href, or null.
 *
 * Approach: find every `<link ...>` tag, extract its attributes into a map,
 * keep the ones whose `rel` mentions "icon", and return the first non-data,
 * non-http href. Cheaper than building a real parser for this one tag.
 */
export function findFaviconHrefInHtml(html: string): string | null {
  const linkTagRe = /<link\b([^>]*)>/gi
  const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let tagMatch: RegExpExecArray | null
  while ((tagMatch = linkTagRe.exec(html)) !== null) {
    const attrs: Record<string, string> = {}
    const attrBlock = tagMatch[1]
    let am: RegExpExecArray | null
    attrRe.lastIndex = 0
    while ((am = attrRe.exec(attrBlock)) !== null) {
      const name = am[1].toLowerCase()
      const value = am[3] ?? am[4] ?? ''
      attrs[name] = value
    }
    const rel = (attrs['rel'] ?? '').toLowerCase()
    if (!rel.split(/\s+/).includes('icon')) continue
    const href = attrs['href']
    if (!href) continue
    if (/^data:/i.test(href)) continue
    if (/^https?:/i.test(href)) continue
    return href
  }
  return null
}

/**
 * Resolve an href (as found in an HTML link tag) to an absolute on-disk
 * path. `htmlFileAbs` is the file the href came from; `projectRoot` is
 * the project root used both for `/`-rooted hrefs and as the containment
 * boundary.
 *
 * Returns the absolute path only if it lives inside projectRoot. `null`
 * for traversal attempts or anything outside the project.
 */
function resolveHrefToAbs(
  href: string,
  htmlFileAbs: string,
  projectRoot: string,
): string | null {
  // Strip any URL fragment / query that snuck in
  const cleaned = href.split('#')[0].split('?')[0]
  if (!cleaned) return null

  // `/foo` is project-root-relative (web convention). Anything else is
  // resolved against the HTML file's directory.
  const candidateAbs = cleaned.startsWith('/')
    ? resolve(projectRoot, '.' + cleaned)
    : resolve(htmlFileAbs, '..', cleaned)

  // Containment check: candidateAbs must be inside projectRoot. Use
  // path.relative — if the result starts with `..` or is absolute, the
  // candidate escapes the root.
  const rel = relative(projectRoot, candidateAbs)
  if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return null

  return candidateAbs
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    const st = await fs.stat(abs)
    return st.isFile()
  } catch {
    return false
  }
}

export async function resolveFaviconViaHtml(projectPath: string): Promise<FaviconResult | null> {
  for (const segments of CANDIDATE_HTML_FILES) {
    const htmlAbs = join(projectPath, ...segments)
    let html: string
    try {
      html = await fs.readFile(htmlAbs, 'utf8')
    } catch {
      continue
    }
    const href = findFaviconHrefInHtml(html)
    if (!href) continue
    const resolved = resolveHrefToAbs(href, htmlAbs, projectPath)
    if (!resolved) continue
    if (!(await fileExists(resolved))) continue
    return { absPath: resolved, mime: mimeFor(resolved) }
  }
  return null
}

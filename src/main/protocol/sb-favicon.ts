/**
 * `sb-favicon://` Electron custom protocol — serves a project's auto-detected
 * favicon to the renderer's <img> tag in the sidebar. Mirrors the existing
 * `sb-tour://` registration in main/index.ts.
 *
 * URL shape: `sb-favicon://favicon?path=<percent-encoded-absolute-project-path>`
 *   - hostname pinned to `favicon` so `new URL` always parses
 *   - the project path travels in a query param so we don't have to deal
 *     with hostname-encoding of `/`, `:`, `\` etc. across OSes
 *
 * Security:
 *   1. The path query param must exactly match one of the registered
 *      projects (DB-backed `knownProjectsLookup`). The renderer can only
 *      ask for favicons of projects it actually has registered — no
 *      arbitrary disk reads.
 *   2. The favicon resolver itself only probes a fixed list of paths
 *      *inside* the project root (faviconResolver.ts), so even with a
 *      poisoned project entry the disk reads stay scoped.
 *
 * The pure functions exported here (parseFaviconUrl, isAuthorizedProjectPath)
 * are unit-tested. registerFaviconProtocol is the thin Electron wire-up
 * called from main/index.ts.
 */
import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { resolveProjectFavicon } from '../projects/faviconResolver'

export interface ParsedFaviconUrl {
  projectPath: string
}

export function parseFaviconUrl(rawUrl: string): ParsedFaviconUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'sb-favicon:') return null
  const projectPath = url.searchParams.get('path')
  if (!projectPath) return null
  return { projectPath }
}

/**
 * Exact-match containment check. The favicon protocol may only serve
 * projects the renderer has registered — anything else is an attack or
 * a bug. Prefix matching is intentionally disallowed: a known project
 * at `/Users/me/foo` does NOT authorize requests for `/Users/me/foo/.env`.
 */
export function isAuthorizedProjectPath(
  projectPath: string,
  knownProjectPaths: ReadonlyArray<string>,
): boolean {
  return knownProjectPaths.includes(projectPath)
}

/** Lazy lookup so the protocol handler can pull from DB at request time. */
export type KnownProjectsLookup = () => ReadonlyArray<string>

/**
 * Register the `sb-favicon` protocol handler. Call from main/index.ts in
 * the same `app.whenReady` block that registers `sb-tour`.
 */
export function registerFaviconProtocol(getKnownProjects: KnownProjectsLookup): void {
  protocol.handle('sb-favicon', async (request) => {
    const parsed = parseFaviconUrl(request.url)
    if (!parsed) return new Response('bad request', { status: 400 })

    if (!isAuthorizedProjectPath(parsed.projectPath, getKnownProjects())) {
      return new Response('forbidden', { status: 403 })
    }

    const favicon = await resolveProjectFavicon(parsed.projectPath)
    if (!favicon) return new Response('not found', { status: 404 })

    // pathToFileURL handles Windows drive letters / backslashes correctly;
    // hand-rolled `'file://' + abs` strings break on win32.
    const res = await net.fetch(pathToFileURL(favicon.absPath).toString())

    // Override Content-Type so the renderer's <img> tag picks up the
    // right MIME (some servers / proxies sniff .svg as text/xml).
    const headers = new Headers(res.headers)
    headers.set('Content-Type', favicon.mime)
    headers.set('Cache-Control', 'public, max-age=3600')
    return new Response(res.body, { status: res.status, headers })
  })
}

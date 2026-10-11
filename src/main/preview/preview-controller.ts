/**
 * The HTML preview's document state and sandbox policy, kept free of Electron
 * imports so the security rules are unit-tested directly. `preview-session.ts`
 * wires it to the real session, protocol and IPC.
 *
 * One document at a time (the pane has one webview). Every open mints a new
 * token; the page's origin is `sb-preview://<token>`, so a request from a
 * stale page, or for any other origin, is refused.
 */
import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path'
import {
  PREVIEW_MAX_BYTES,
  PREVIEW_SCHEME,
  isHtmlPreviewPath,
  previewAssetRelativePath,
  previewDocumentUrl,
  previewNavigationAllowed,
  previewRequestVerdict,
  type PreviewEvent,
  type PreviewOpenRequest,
  type PreviewOpenResult,
} from '@shared/html-preview'
import { createMainLogger } from '../logger'

const log = createMainLogger('preview:controller')

/** Quiet gap before a burst of file writes reloads the page. */
export const PREVIEW_RELOAD_DEBOUNCE_MS = 250
/** Blocked-request events per document; a page polling the network stops here. */
const MAX_BLOCKED_EVENTS = 50
/** Largest asset served from the document's folder. */
const MAX_ASSET_BYTES = 50 * 1024 * 1024

/** Defense in depth behind the session's request filter: the page itself may
 *  not name any other origin either. */
export const PREVIEW_CSP = [
  `default-src ${PREVIEW_SCHEME}: data: blob: 'unsafe-inline' 'unsafe-eval'`,
  `connect-src ${PREVIEW_SCHEME}: data: blob:`,
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
}

type CurrentDocument =
  | { kind: 'file'; token: string; url: string; filePath: string; folder: string; realFolder: string }
  | { kind: 'content'; token: string; url: string; fileName: string; html: string }

/** The parts of a guest WebContents the guards use. */
export interface PreviewGuestContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): void
}

export interface PreviewRequestDetails {
  url: string
  resourceType?: string
}

/**
 * Resolve a document-relative asset path to a real file inside `realFolder`,
 * or null. Realpaths the candidate, so a symlink pointing out of the folder is
 * refused the same as `..`.
 */
export async function resolvePreviewAsset(realFolder: string, relPath: string): Promise<string | null> {
  const candidate = join(realFolder, relPath)
  let real: string
  try {
    real = await fs.realpath(candidate)
  } catch (err) {
    log.debug('preview asset not found', { code: (err as NodeJS.ErrnoException).code })
    return null
  }
  const rel = relative(realFolder, real)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return real
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export class PreviewController {
  private doc: CurrentDocument | null = null
  private watcher: FSWatcher | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private blockedCount = 0

  constructor(private readonly emit: (event: PreviewEvent) => void) {}

  get currentToken(): string | null {
    return this.doc?.token ?? null
  }

  get currentUrl(): string | null {
    return this.doc?.url ?? null
  }

  async open(request: PreviewOpenRequest): Promise<PreviewOpenResult> {
    this.close()
    const token = randomBytes(12).toString('hex')
    if (request.kind === 'content') {
      const fileName = basename(request.fileName.replaceAll('\\', '/'))
      if (!isHtmlPreviewPath(fileName)) return { ok: false, error: 'not-html' }
      const bytes = Buffer.byteLength(request.html, 'utf8')
      if (bytes > PREVIEW_MAX_BYTES) return { ok: false, error: 'too-large', bytes }
      const url = previewDocumentUrl(token, fileName)
      this.doc = { kind: 'content', token, url, fileName, html: request.html }
      log.info('preview opened', { kind: 'content', bytes })
      return { ok: true, url, token, bytes }
    }
    const filePath = request.filePath
    if (!isAbsolute(filePath)) return { ok: false, error: 'failed', message: 'The preview needs an absolute path.' }
    if (!isHtmlPreviewPath(filePath)) return { ok: false, error: 'not-html' }
    let bytes: number
    let realFolder: string
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return { ok: false, error: 'not-found' }
      bytes = stat.size
      realFolder = await fs.realpath(dirname(filePath))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: 'not-found' }
      log.warn('preview stat failed', err)
      return { ok: false, error: 'failed', message: (err as Error).message }
    }
    if (bytes > PREVIEW_MAX_BYTES) return { ok: false, error: 'too-large', bytes }
    const url = previewDocumentUrl(token, basename(filePath))
    this.doc = { kind: 'file', token, url, filePath, folder: dirname(filePath), realFolder }
    this.watchFolder(token, filePath)
    log.info('preview opened', { kind: 'file', bytes })
    return { ok: true, url, token, bytes }
  }

  close(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = null
    this.watcher?.close()
    this.watcher = null
    this.doc = null
    this.blockedCount = 0
  }

  /**
   * Watches the document's folder, not the file: agents write through a temp
   * file and a rename, which ends a watch on the old inode, and an edited
   * stylesheet next to the page should reload it too.
   */
  private watchFolder(token: string, filePath: string): void {
    try {
      this.watcher = watch(dirname(filePath), { persistent: false }, () => this.scheduleReload(token, filePath))
      this.watcher.on('error', (err) => {
        log.warn('preview folder watch failed', err)
        this.watcher?.close()
        this.watcher = null
      })
    } catch (err) {
      log.warn('preview folder watch could not start', err)
    }
  }

  private scheduleReload(token: string, filePath: string): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      void fs.stat(filePath).then(
        () => {
          if (this.doc?.token === token) this.emit({ type: 'changed', token })
        },
        (err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') log.warn('preview stat after change failed', err)
          if (this.doc?.token === token) this.emit({ type: 'missing', token })
        },
      )
    }, PREVIEW_RELOAD_DEBOUNCE_MS)
  }

  /** `session.webRequest.onBeforeRequest` body: true cancels the request. */
  shouldCancelRequest(details: PreviewRequestDetails): boolean {
    if (previewRequestVerdict(details.url, this.currentToken) === 'allow') return false
    const token = this.currentToken
    if (token && this.blockedCount < MAX_BLOCKED_EVENTS && !details.url.startsWith('devtools:')) {
      this.blockedCount++
      this.emit({ type: 'blocked', token, url: details.url })
    }
    return true
  }

  /** Guards on every guest WebContents of the preview session. */
  attachGuards(contents: PreviewGuestContents): void {
    contents.setWindowOpenHandler(() => {
      log.info('preview window.open denied')
      return { action: 'deny' }
    })
    const keepOnDocument = (event: { preventDefault(): void }, url: string): void => {
      if (url === 'about:blank' || previewNavigationAllowed(url, this.currentUrl)) return
      event.preventDefault()
      log.info('preview navigation blocked')
    }
    contents.on('will-navigate', keepOnDocument)
    contents.on('will-redirect', keepOnDocument)
  }

  /** `protocol.handle(PREVIEW_SCHEME)` body. */
  async serve(requestUrl: string): Promise<Response> {
    const doc = this.doc
    let parsed: URL
    try {
      parsed = new URL(requestUrl)
    } catch (err) {
      log.debug('preview request URL did not parse', err)
      return textResponse(400, 'Bad request')
    }
    if (!doc || parsed.hostname !== doc.token) return textResponse(404, 'Not found')
    const relPath = previewAssetRelativePath(parsed.pathname)
    if (!relPath) return textResponse(404, 'Not found')

    if (doc.kind === 'content') {
      if (relPath !== doc.fileName) return textResponse(404, 'Not found')
      return new Response(doc.html, {
        headers: { 'content-type': MIME['.html'], 'content-security-policy': PREVIEW_CSP },
      })
    }

    const abs = await resolvePreviewAsset(doc.realFolder, relPath)
    if (!abs) return textResponse(404, 'Not found')
    try {
      const stat = await fs.stat(abs)
      if (!stat.isFile()) return textResponse(404, 'Not found')
      if (stat.size > MAX_ASSET_BYTES) return textResponse(413, 'Too large')
      const body = await fs.readFile(abs)
      const ext = extname(abs).toLowerCase()
      const headers: Record<string, string> = { 'content-type': MIME[ext] ?? 'application/octet-stream' }
      if (ext === '.html' || ext === '.htm') headers['content-security-policy'] = PREVIEW_CSP
      return new Response(body, { headers })
    } catch (err) {
      log.warn('preview asset read failed', err)
      return textResponse(404, 'Not found')
    }
  }
}

/**
 * The HTML preview's document state and sandbox policy, kept free of Electron
 * imports so the security rules are unit-tested directly. `preview-session.ts`
 * wires it to the real session, protocol and IPC.
 *
 * The pane shows one document at a time; inline ```html-live frames in chat
 * messages each hold their own (`openInline`). Every open mints a new token;
 * the page's origin is `sb-preview://<token>`, so a request from a stale page,
 * or for any other origin, is refused. `/_sb/<library>` on any document's
 * origin is a bundled library (shared/html-live.ts), never a file.
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
import {
  HTML_LIVE_DOCUMENT_NAME,
  htmlLiveDocument,
  htmlLiveVerdict,
  isHtmlLiveLibrary,
  type HtmlLiveTheme,
} from '@shared/html-live'
import { resolveWithinRepo } from '../ipc/files'
import { createMainLogger } from '../logger'

const log = createMainLogger('preview:controller')

/** Quiet gap before a burst of file writes reloads the page. */
export const PREVIEW_RELOAD_DEBOUNCE_MS = 250
/** Blocked-request events per document; a page polling the network stops here. */
const MAX_BLOCKED_EVENTS = 50
/** Largest asset served from the document's folder. */
const MAX_ASSET_BYTES = 50 * 1024 * 1024
/** Inline frame documents kept at once; the renderer closes its own, this
 *  only bounds what a crashed or reloaded renderer leaves behind. */
const MAX_INLINE_DOCUMENTS = 16

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
  | { kind: 'live'; token: string; url: string; html: string }

/** Where a bundled /_sb/ library is on disk (an `HTML_LIVE_LIBRARIES` path), or null. */
export type LiveLibraryResolver = (path: string) => string | null

export interface InlineOpenRequest {
  source: string
  theme: HtmlLiveTheme
}

/** The parts of a guest WebContents the guards use. */
export interface PreviewGuestContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }, url: string) => void): void
}

export interface PreviewRequestDetails {
  url: string
  resourceType?: string
  /** URL of the frame that made the request, when Electron still knows it. */
  frameUrl?: string | null
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
  private readonly inline = new Map<string, Extract<CurrentDocument, { kind: 'live' }>>()
  private watcher: FSWatcher | null = null
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private readonly blockedCounts = new Map<string, number>()

  constructor(
    private readonly emit: (event: PreviewEvent) => void,
    private readonly libraryFile: LiveLibraryResolver = () => null,
  ) {}

  /** The pane's document or an inline frame's, by token. */
  private documentFor(token: string): CurrentDocument | null {
    if (this.doc?.token === token) return this.doc
    return this.inline.get(token) ?? null
  }

  /** The token of a live document a preview URL belongs to, or null. */
  private tokenOfUrl(url: string | null | undefined): string | null {
    if (!url?.startsWith(`${PREVIEW_SCHEME}:`)) return null
    try {
      const host = new URL(url).hostname
      return this.documentFor(host) ? host : null
    } catch (err) {
      log.debug('preview URL did not parse', err)
      return null
    }
  }

  /** A live page's document, or the reason it does not run. */
  private liveDocument(request: InlineOpenRequest): { html: string; bytes: number } | PreviewOpenResult {
    const verdict = htmlLiveVerdict(request.source)
    if (!verdict.ok) {
      return verdict.reason === 'too-large'
        ? { ok: false, error: 'too-large', bytes: verdict.bytes }
        : { ok: false, error: 'failed', message: `Unknown library: ${verdict.names.join(', ')}` }
    }
    const html = htmlLiveDocument(request.source, request.theme)
    return { html, bytes: Buffer.byteLength(html, 'utf8') }
  }

  /** An inline frame's document. Kept until `closeInline`, apart from the pane's. */
  openInline(request: InlineOpenRequest): PreviewOpenResult {
    if (typeof request?.source !== 'string') return { ok: false, error: 'failed', message: 'No page.' }
    const built = this.liveDocument(request)
    if ('ok' in built) return built
    const token = randomBytes(12).toString('hex')
    const url = previewDocumentUrl(token, HTML_LIVE_DOCUMENT_NAME)
    this.inline.set(token, { kind: 'live', token, url, html: built.html })
    while (this.inline.size > MAX_INLINE_DOCUMENTS) this.closeInline(this.inline.keys().next().value as string)
    log.debug('inline page opened', { bytes: built.bytes, open: this.inline.size })
    return { ok: true, url, token, bytes: built.bytes }
  }

  closeInline(token: string): void {
    this.inline.delete(token)
    this.blockedCounts.delete(token)
  }

  get currentToken(): string | null {
    return this.doc?.token ?? null
  }

  get currentUrl(): string | null {
    return this.doc?.url ?? null
  }

  async open(request: PreviewOpenRequest): Promise<PreviewOpenResult> {
    this.close()
    const token = randomBytes(12).toString('hex')
    if (request.kind === 'live') {
      const built = this.liveDocument(request)
      if ('ok' in built) return built
      const url = previewDocumentUrl(token, HTML_LIVE_DOCUMENT_NAME)
      this.doc = { kind: 'live', token, url, html: built.html }
      log.info('preview opened', { kind: 'live', bytes: built.bytes })
      return { ok: true, url, token, bytes: built.bytes }
    }
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
    try {
      // Only a file inside the chat's folder, symlinks resolved.
      await resolveWithinRepo(request.root, filePath)
    } catch (err) {
      log.warn('preview refused a file outside the chat folder', err)
      return { ok: false, error: 'failed', message: "The file is outside this chat's project folder." }
    }
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

  /** Drops the pane's document; inline frames keep theirs. */
  close(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer)
    this.reloadTimer = null
    this.watcher?.close()
    this.watcher = null
    if (this.doc) this.blockedCounts.delete(this.doc.token)
    this.doc = null
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
    if (previewRequestVerdict(details.url, this.tokenOfUrl(details.url)) === 'allow') return false
    // Blame the page that asked; with no frame to go by, the pane's (as before inline frames).
    const token = this.tokenOfUrl(details.frameUrl) ?? this.currentToken
    const count = token ? (this.blockedCounts.get(token) ?? 0) : MAX_BLOCKED_EVENTS
    if (token && count < MAX_BLOCKED_EVENTS && !details.url.startsWith('devtools:')) {
      this.blockedCounts.set(token, count + 1)
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
      const token = this.tokenOfUrl(url)
      const doc = token ? this.documentFor(token) : null
      if (url === 'about:blank' || previewNavigationAllowed(url, doc?.url ?? null)) return
      event.preventDefault()
      log.info('preview navigation blocked')
    }
    contents.on('will-navigate', keepOnDocument)
    contents.on('will-redirect', keepOnDocument)
  }

  /** `protocol.handle(PREVIEW_SCHEME)` body. */
  async serve(requestUrl: string): Promise<Response> {
    let parsed: URL
    try {
      parsed = new URL(requestUrl)
    } catch (err) {
      log.debug('preview request URL did not parse', err)
      return textResponse(400, 'Bad request')
    }
    const doc = this.documentFor(parsed.hostname)
    if (!doc) return textResponse(404, 'Not found')
    const relPath = previewAssetRelativePath(parsed.pathname)
    if (!relPath) return textResponse(404, 'Not found')

    // The bundled libraries, so a live page saved as a file still draws in the pane.
    const library = relPath.startsWith('_sb/') ? relPath.slice(4) : null
    if (library && isHtmlLiveLibrary(library)) return this.serveLibrary(library)
    if (doc.kind === 'live') {
      if (relPath !== HTML_LIVE_DOCUMENT_NAME) return textResponse(404, 'Not found')
      return new Response(doc.html, {
        headers: { 'content-type': MIME['.html'], 'content-security-policy': PREVIEW_CSP },
      })
    }

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

  /** A bundled library (an `HTML_LIVE_LIBRARIES` path) from the app's own files. */
  private async serveLibrary(path: string): Promise<Response> {
    const file = this.libraryFile(path)
    if (!file) return textResponse(404, 'Not found')
    try {
      return new Response(await fs.readFile(file), { headers: { 'content-type': MIME['.js'] } })
    } catch (err) {
      log.warn('bundled library read failed', { path, code: (err as NodeJS.ErrnoException).code })
      return textResponse(404, 'Not found')
    }
  }
}

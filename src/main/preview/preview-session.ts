/**
 * Electron glue for the HTML preview: the preview session (its own partition),
 * its protocol, its request filter and the IPC the pane drives. Desktop only;
 * the policy itself lives in `preview-controller.ts`.
 */
import { app, ipcMain, session, shell, webContents, type BrowserWindow, type Session, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { HtmlLiveChannels, PreviewChannels } from '@shared/ipc-channels'
import {
  PREVIEW_PARTITION,
  PREVIEW_SCHEME,
  isHtmlPreviewPath,
  type PreviewOpenRequest,
  type PreviewEvent,
} from '@shared/html-preview'
import { HTML_LIVE_MAX_IMAGE_CHARS } from '@shared/html-live'
import { PreviewController, type InlineOpenRequest } from './preview-controller'
import { createMainLogger } from '../logger'

const log = createMainLogger('preview:session')

let controller: PreviewController | null = null
let previewSession: Session | null = null
let getWindow: () => BrowserWindow | null = () => null

function emit(event: PreviewEvent): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(PreviewChannels.EVENT, event)
}

let liveLibraryRoot: string | null | undefined

/** `resources/sb-live` (extraResources when packaged), or the app's own mermaid copy. */
function liveLibraryFile(path: string): string | null {
  if (path === 'mermaid.js') {
    try {
      return require.resolve('mermaid/dist/mermaid.min.js')
    } catch (err) {
      log.warn('bundled mermaid not found', err)
      return null
    }
  }
  if (liveLibraryRoot === undefined) {
    const candidates = [join(process.resourcesPath ?? '', 'sb-live'), join(app.getAppPath(), 'resources', 'sb-live')]
    liveLibraryRoot = candidates.find((dir) => existsSync(dir)) ?? null
    if (!liveLibraryRoot) log.warn('bundled live page libraries not found', { candidates: candidates.length })
  }
  return liveLibraryRoot ? join(liveLibraryRoot, ...path.split('/')) : null
}

function ensureController(): PreviewController {
  controller ??= new PreviewController(emit, liveLibraryFile)
  return controller
}

/** The requesting frame's URL; Electron throws when the frame is already gone. */
function requestFrameUrl(details: Electron.OnBeforeRequestListenerDetails): string | null {
  try {
    return details.frame?.url ?? null
  } catch (err) {
    log.debug('request frame gone', err)
    return null
  }
}

/** The preview partition's session, configured on first use. */
function ensurePreviewSession(): Session {
  if (previewSession) return previewSession
  const ses = session.fromPartition(PREVIEW_PARTITION)
  const ctl = ensureController()
  ses.protocol.handle(PREVIEW_SCHEME, (request) => ctl.serve(request.url))
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: ctl.shouldCancelRequest({ url: details.url, frameUrl: requestFrameUrl(details) }) })
  })
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  // A dead proxy for everything, loopback included: catches what never shows
  // up as a web request (WebRTC over TCP, DNS prefetch).
  ses
    .setProxy({ proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' })
    .catch((err) => log.warn('preview proxy setup failed', err))
  previewSession = ses
  return ses
}

export function isPreviewContents(contents: WebContents): boolean {
  return contents.getType() === 'webview' && contents.session === ensurePreviewSession()
}

/** Call from `app.on('web-contents-created')` for every preview guest. */
export function attachPreviewGuestGuards(contents: WebContents): void {
  ensureController().attachGuards(contents)
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
}

/**
 * `will-attach-webview` on the app window: whatever the renderer asked for, a
 * preview guest gets no preload, no Node and a sandboxed, isolated renderer.
 */
export function hardenPreviewWebviewPreferences(
  webPreferences: Electron.WebPreferences,
  params: Record<string, string>,
): void {
  if (params.partition !== PREVIEW_PARTITION) return
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.experimentalFeatures = false
  webPreferences.navigateOnDragDrop = false
}

function previewGuest(webContentsId: number): WebContents | null {
  const contents = webContents.fromId(webContentsId)
  if (!contents || contents.isDestroyed() || contents.session !== ensurePreviewSession()) return null
  return contents
}

export function registerHtmlPreviewHandlers(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  ipcMain.removeHandler(PreviewChannels.OPEN)
  ipcMain.handle(PreviewChannels.OPEN, (_event, request: PreviewOpenRequest) => {
    ensurePreviewSession()
    return ensureController().open(request)
  })
  ipcMain.removeHandler(HtmlLiveChannels.INLINE_OPEN)
  ipcMain.handle(HtmlLiveChannels.INLINE_OPEN, (_event, request: InlineOpenRequest) => {
    ensurePreviewSession()
    return ensureController().openInline(request)
  })
  ipcMain.removeHandler(HtmlLiveChannels.INLINE_CLOSE)
  ipcMain.handle(HtmlLiveChannels.INLINE_CLOSE, (_event, token: string) => {
    if (typeof token === 'string') controller?.closeInline(token)
    return { ok: true }
  })
  ipcMain.removeHandler(HtmlLiveChannels.INLINE_CAPTURE)
  ipcMain.handle(HtmlLiveChannels.INLINE_CAPTURE, async (_event, webContentsId: number): Promise<string | null> => {
    const guest = previewGuest(webContentsId)
    if (!guest) return null
    try {
      const image = await guest.capturePage()
      if (image.isEmpty()) return null
      const png = image.toDataURL()
      // A tall 2x frame can outgrow the stored image cap as PNG; JPEG fits.
      return png.length <= HTML_LIVE_MAX_IMAGE_CHARS
        ? png
        : `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`
    } catch (err) {
      log.warn('inline page capture failed', err)
      return null
    }
  })
  ipcMain.removeHandler(PreviewChannels.CLOSE)
  ipcMain.handle(PreviewChannels.CLOSE, () => {
    controller?.close()
    return { ok: true }
  })
  ipcMain.removeHandler(PreviewChannels.SET_COLOR_SCHEME)
  ipcMain.handle(
    PreviewChannels.SET_COLOR_SCHEME,
    async (_event, webContentsId: number, scheme: 'light' | 'dark'): Promise<{ ok: boolean }> => {
      const guest = previewGuest(webContentsId)
      if (!guest) return { ok: false }
      try {
        if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
        await guest.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme === 'dark' ? 'dark' : 'light' }],
        })
        return { ok: true }
      } catch (err) {
        log.warn('preview color scheme failed', err)
        return { ok: false }
      }
    },
  )
  ipcMain.removeHandler(PreviewChannels.OPEN_EXTERNAL)
  ipcMain.handle(PreviewChannels.OPEN_EXTERNAL, async (_event, filePath: string): Promise<{ ok: boolean }> => {
    // The user's own browser, outside the sandbox: only an existing local .html file.
    if (typeof filePath !== 'string' || !isAbsolute(filePath) || !isHtmlPreviewPath(filePath)) return { ok: false }
    try {
      if (!(await stat(filePath)).isFile()) return { ok: false }
      await shell.openExternal(pathToFileURL(filePath).href)
      return { ok: true }
    } catch (err) {
      log.warn('preview open in browser failed', err)
      return { ok: false }
    }
  })
}

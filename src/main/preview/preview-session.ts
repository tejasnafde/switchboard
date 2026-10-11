/**
 * Electron glue for the HTML preview: the preview session (its own partition),
 * its protocol, its request filter and the IPC the pane drives. Desktop only;
 * the policy itself lives in `preview-controller.ts`.
 */
import { ipcMain, session, shell, webContents, type BrowserWindow, type Session, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { PreviewChannels } from '@shared/ipc-channels'
import {
  PREVIEW_PARTITION,
  PREVIEW_SCHEME,
  isHtmlPreviewPath,
  type PreviewOpenRequest,
  type PreviewEvent,
} from '@shared/html-preview'
import { PreviewController } from './preview-controller'
import { createMainLogger } from '../logger'

const log = createMainLogger('preview:session')

let controller: PreviewController | null = null
let previewSession: Session | null = null
let getWindow: () => BrowserWindow | null = () => null

function emit(event: PreviewEvent): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(PreviewChannels.EVENT, event)
}

function ensureController(): PreviewController {
  controller ??= new PreviewController(emit)
  return controller
}

/** The preview partition's session, configured on first use. */
function ensurePreviewSession(): Session {
  if (previewSession) return previewSession
  const ses = session.fromPartition(PREVIEW_PARTITION)
  const ctl = ensureController()
  ses.protocol.handle(PREVIEW_SCHEME, (request) => ctl.serve(request.url))
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: ctl.shouldCancelRequest(details) })
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

// Prevent EPIPE crashes from killing the app
process.on('uncaughtException', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return // ignore broken pipe
  console.error('Uncaught:', err)
})

// Surface promise rejections that nobody awaited. Without this, an
// adapter or IPC handler that throws inside a fire-and-forget Promise
// vanishes silently - the bug shows up days later as "the UI just
// stopped updating" with zero log trail. We log and keep the process
// alive (Node's default may switch to crash-on-unhandled in future
// majors; explicit handler keeps behaviour predictable).
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
  console.error('Unhandled rejection:', msg)
})

import { app, BrowserWindow, dialog, shell, nativeImage, ipcMain, Menu, protocol, net, screen } from 'electron'
import { join, basename } from 'path'
import { registerTerminalHandlers, shutdownTerminals } from './ipc/terminal'
import { registerAgentHandlers } from './ipc/agent'
import { registerPushHandlers } from './ipc/push'
import { attachPushNotifier } from './push/registry'
import { registerAppHandlers } from './ipc/app'
import { registerAppDesktopHandlers } from './ipc/app-desktop'
import { registerMachineHandlers, stopAllMachineConnections } from './ipc/machines'
import { registerFilesHandlers } from './ipc/files'
import { ElectronIpcHost, type BackendHost } from './backend/host'
import { MultiHost } from './backend/multi-host'
import { createPairingCode, listSessionViews, revokeSession } from './backend/device-sessions'
import { MobileEndpoint } from './backend/mobile-server'
import { registerGitHandlers } from './ipc/git'
import { registerIdeHandlers } from './ipc/ide'
import { registerKanbanHandlers } from './ipc/kanban'
import { registerProviderInstanceHandlers } from './ipc/providerInstances'
import { resolveProviderInstance } from './db/providerInstances'
import { registerAutoUpdater, quitAndInstall, reportInstallStatus } from './updater'
import { QuitCoordinator } from './quit-coordinator'
import { ProviderRegistry } from './provider/provider-registry'
import { disposeUsageProbes } from './provider/usage'
import { getDb, closeDb, getSetting, setSetting, getProjects } from './db/database'
import { registerFaviconProtocol } from './protocol/sb-favicon'
import { getLogDir, getLogFilePath, createMainLogger } from './logger'

const log = createMainLogger('tour')
import { AppChannels, ProviderInstanceChannels } from '@shared/ipc-channels'
import type { AgentType } from '@shared/types'

/** Unpackaged means a dev run, where a stale instance is the usual lock holder. */
const isDev = !app.isPackaged

/** Unsubscribe for the push notifier, so a reactivated window can re-attach. */
let detachPush: (() => void) | null = null

let mainWindow: BrowserWindow | null = null
let providerRegistry: ProviderRegistry | null = null
/** Mobile pairing WS endpoint (null when no token is configured). */
let mobileEndpoint: MobileEndpoint | null = null
/** True once the user has asked for restart-and-install; repeats are dropped. */
let installRequested = false

// ⌘R / ⌘⇧R go through a confirm dialog instead of the raw reload roles -
// a stray reload kills terminal panes and in-flight agent turns.
const menuLog = createMainLogger('app:menu')
const ideLog = createMainLogger('ide:popup')
let reloadDialogOpen = false
async function confirmReload(force: boolean): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (!win || win.isDestroyed() || reloadDialogOpen) return
  reloadDialogOpen = true
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [force ? 'Force Reload' : 'Reload', 'Cancel'],
      defaultId: 0,
      cancelId: 1, // Escape lands here
      message: force ? 'Force reload Switchboard?' : 'Reload Switchboard?',
      detail:
        'This restarts the renderer. Terminal panes, in-flight agent turns, and unsent drafts in this window will be reset.',
    })
    if (response === 0) {
      menuLog.info('renderer reload confirmed', { force })
      if (force) win.webContents.reloadIgnoringCache()
      else win.webContents.reload()
    }
  } finally {
    reloadDialogOpen = false
  }
}

// Custom protocol for onboarding tour videos. Must be registered as
// privileged BEFORE app.whenReady so the renderer can use it in
// <video src="sb-tour://...">. Maps `sb-tour://<id>.mp4` to
// `videos/dist/<id>.mp4` inside the app bundle. See
// `registerTourProtocol` below for the file-resolution.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sb-tour',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true, // needed for <video> seek/range requests
    },
  },
  {
    // Sidebar leading-icon protocol - serves the project's auto-detected
    // favicon. Implementation in main/protocol/sb-favicon.ts; renderer
    // uses it via <img src="sb-favicon://favicon?path=...">.
    scheme: 'sb-favicon',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
])

// Dev escape hatch: relocate userData so a second instance can run alongside
// the installed app for testing (own profile => own single-instance lock).
// Must run before requestSingleInstanceLock, which keys off the userData path.
if (process.env.SB_USER_DATA) {
  app.setPath('userData', process.env.SB_USER_DATA)
}

// Handle the code-oss:// scheme that the embedded code-server emits. Extension
// post-OAuth "return to editor" deep links (e.g. atlascode's "Back to
// code-server") use it; without a registered handler they dead-end in the
// browser. We just focus the app - auth already completed via the extension's
// own loopback server, so there's nothing to forward into the workbench.
app.setAsDefaultProtocolClient('code-oss')
app.on('open-url', (event, url) => {
  event.preventDefault()
  ideLog.info('open-url', { url })
  const win = mainWindow
  // Same destroyed-window trap as the second-instance handler above.
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  app.focus({ steal: true })
})

// Single instance lock - prevent multiple windows
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // In dev this is almost always a STALE process from an earlier `npm run dev`
  // whose window was closed: it still holds the lock, so the fresh build loses
  // and exits. Silence made that look like "you have to run it twice".
  if (isDev) {
    log.error(
      'another Switchboard holds the single-instance lock - probably an earlier `npm run dev`. ' +
        'It is being asked to quit; re-run `npm run dev`. To check: ' +
        "lsof -nP -iTCP:8765 -sTCP:LISTEN",
    )
  }
  app.quit()
} else {
  app.on('second-instance', () => {
    // `mainWindow` stays non-null after the window is destroyed, so the null
    // check alone is not enough: touching a destroyed BrowserWindow throws
    // "Object has been destroyed". That happens for real - a dev process whose
    // window closed but which still holds the lock is exactly what a second
    // `npm run dev` runs into.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      return
    }
    // Lock held but no window to raise. In dev that means THIS process is a
    // stale husk: its renderer was served by a vite server that died with the
    // old run, so recreating a window here would load a dead URL. Quit instead
    // and release the lock, so the next run - with the fresh build - wins.
    if (isDev) {
      log.info('stale dev instance with no window - quitting to release the single-instance lock')
      app.quit()
      return
    }
    log.info('second-instance with no live window - recreating it')
    app.emit('activate')
  })
}

interface SavedBounds { x?: number; y?: number; width: number; height: number; maximized?: boolean }

function loadWindowBounds(): SavedBounds | null {
  try {
    const raw = getSetting('windowBounds')
    if (!raw) return null
    const b = JSON.parse(raw) as SavedBounds
    if (typeof b.width !== 'number' || typeof b.height !== 'number') return null
    // Drop the position if it is no longer on any display (monitor unplugged).
    if (typeof b.x === 'number' && typeof b.y === 'number') {
      const visible = screen.getAllDisplays().some((d) =>
        b.x! >= d.bounds.x && b.x! < d.bounds.x + d.bounds.width &&
        b.y! >= d.bounds.y && b.y! < d.bounds.y + d.bounds.height)
      if (!visible) { delete b.x; delete b.y }
    }
    return b
  } catch (err) {
    log.warn('failed to load saved window bounds', err)
    return null
  }
}

function createWindow(): BrowserWindow {
  const iconPath = join(app.getAppPath(), 'resources/icons/switchboard-logo-1024.png')

  // Check saved theme so we can set vibrancy BEFORE window shows
  let savedTheme: string | null = null
  try { savedTheme = getSetting('theme') } catch (err) { log.warn('theme read failed at window creation', err) }
  const isTranslucent = savedTheme === 'translucent'

  const saved = loadWindowBounds()

  const window = new BrowserWindow({
    width: saved?.width ?? 1400,
    height: saved?.height ?? 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 800,
    minHeight: 600,
    title: 'Switchboard',
    icon: nativeImage.createFromPath(iconPath),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: isTranslucent ? '#00000000' : '#0a0a0a',
    vibrancy: isTranslucent ? 'sidebar' : undefined,
    visualEffectState: 'active',
    transparent: isTranslucent,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Embedded IDE: the code-server workbench renders in a <webview>.
      webviewTag: true,
    },
  })

  // macOS quirk: a window created with `transparent: true` + vibrancy does
  // not composite the NSVisualEffectView until the frame is invalidated -
  // the translucent theme rendered as a dark void until the user resized or
  // zoomed the window. Nudge a re-composite once the first paint is in.
  if (process.platform === 'darwin' && isTranslucent) {
    window.webContents.once('did-finish-load', () => {
      if (window.isDestroyed()) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- null clears vibrancy (Electron types lag)
      window.setVibrancy(null as any)
      window.setVibrancy('sidebar')
      const b = window.getBounds()
      window.setBounds({ ...b, height: b.height + 1 })
      window.setBounds(b)
    })
  }

  // macOS fullscreen + translucent: transparent windows show a black void in
  // fullscreen because macOS doesn't support window transparency in that mode.
  // Fix: disable vibrancy on enter, restore it on leave. Renderer gets an
  // `app:fullscreen-changed` push so it can add a CSS class that forces solid
  // backgrounds while the vibrancy effect is unavailable.
  if (process.platform === 'darwin') {
    window.on('enter-full-screen', () => {
      const theme = getSetting('theme')
      if (theme !== 'translucent') return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.setVibrancy(null as any)
      window.setBackgroundColor('#0a0a0a')
      window.webContents.send('app:fullscreen-changed', true)
    })
    window.on('leave-full-screen', () => {
      const theme = getSetting('theme')
      if (theme !== 'translucent') return
      window.setVibrancy('sidebar')
      window.setBackgroundColor('#00000000')
      window.webContents.send('app:fullscreen-changed', false)
    })
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Intercept in-page navigation (e.g., clicking a <a href="https://..."> link)
  // and open in the default browser instead of hijacking the app.
  window.webContents.on('will-navigate', (event, url) => {
    const currentUrl = window.webContents.getURL()
    // Allow Vite HMR navigation within the app origin
    if (url.startsWith(currentUrl.split('#')[0]) || url.startsWith('http://localhost')) return
    event.preventDefault()
    shell.openExternal(url)
  })

  // Intercept ⌘W / ⌘⇧W - renderer decides whether to close a tab, window, or app
  window.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'w' && input.type === 'keyDown') {
      event.preventDefault()
      window.webContents.send('app:close-pane-or-window', { shift: input.shift })
    }
  })

  // Restore maximized state and remember bounds for next launch.
  if (saved?.maximized) window.maximize()
  window.on('close', () => {
    try {
      setSetting('windowBounds', JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }))
    } catch (err) {
      log.warn('failed to persist window bounds', err)
    }
  })

  // Renderer requests actual window close (after checking no panes to close)
  ipcMain.removeAllListeners('app:close-window')
  ipcMain.on('app:close-window', () => {
    window.close()
  })

  // Quit + relaunch into a downloaded update. Repeat clicks are dropped.
  ipcMain.removeAllListeners('app:quit-and-install')
  ipcMain.on('app:quit-and-install', () => {
    if (installRequested) return
    installRequested = true
    reportInstallStatus(window, { kind: 'installing' })
    // prepare(), not a bare teardown: it marks quit as already-drained, so
    // the before-quit hook below won't preventDefault the quit Squirrel
    // fires to run the install.
    void quitCoordinator.prepare().then(() => quitAndInstall())
    // quitAndInstall replaces the process; if we are still here the install
    // never took (purged staging file, spawn failure). Un-latch so a retry
    // isn't silently dropped - teardown is idempotent.
    setTimeout(() => {
      if (!installRequested) return
      installRequested = false
      log.warn('still running after quitAndInstall - install did not start')
      reportInstallStatus(window, {
        kind: 'error',
        message: 'The update could not start. Quit and reopen the app, then check for updates again.',
      })
    }, 15_000)
  })

  // Expose log paths for Settings/About
  try { ipcMain.removeHandler('app:get-log-paths') } catch { /* ignore */ }
  ipcMain.handle('app:get-log-paths', () => ({
    dir: getLogDir(),
    file: getLogFilePath(),
  }))

  // Forward renderer console to main process stdout for debugging
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    try {
      const levels = ['debug', 'info', 'warn', 'error']
      const src = sourceId ? sourceId.split('/').pop() : ''
      console.log(`[renderer:${levels[level] ?? level}] ${message} (${src}:${line})`)
    } catch { /* EPIPE if stdout is closed - ignore */ }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/**
 * Resolve `sb-tour://<id>.mp4` to a file path under `videos/dist/`.
 * Falls through to a 404 if the file doesn't exist - the renderer's
 * <video> error handler will show the text-only fallback.
 */
function registerTourProtocol(): void {
  const fs = require('fs') as typeof import('fs')
  // Try every plausible root once at registration so we know upfront
  // where the videos actually live (electron-vite's `app.getAppPath()`
  // in dev returns out/, not the project root, so the naive resolve
  // misses).
  const roots = [
    // Packaged app: extraResources lands here. Check first so dev's stale
    // `out/` doesn't shadow a fresh DMG install.
    join(process.resourcesPath, 'videos', 'dist'),
    join(app.getAppPath(), 'videos', 'dist'),
    join(app.getAppPath(), '..', 'videos', 'dist'),
    join(app.getAppPath(), '..', '..', 'videos', 'dist'),
    join(process.cwd(), 'videos', 'dist'),
    join(__dirname, '..', '..', 'videos', 'dist'),
    join(__dirname, '..', '..', '..', 'videos', 'dist'),
  ]
  let videosRoot: string | null = null
  for (const r of roots) {
    if (fs.existsSync(r)) { videosRoot = r; break }
  }
  log.info(`[tour] videosRoot = ${videosRoot ?? '(none found)'} - searched: ${roots.join(' | ')}`)

  protocol.handle('sb-tour', async (request) => {
    log.info(`[tour] request: ${request.url}`)
    try {
      const url = new URL(request.url)
      // `new URL('sb-tour://welcome.mp4')` parses welcome.mp4 as the
      // hostname (with a trailing pathname of '/'), NOT as the path.
      // Concatenating hostname+pathname therefore yields 'welcome.mp4/'
      // - a string with a slash, which our old guard then rejected as
      // forbidden. Strip the trailing slash and pull just the hostname
      // when the pathname is empty/'/'.
      const rawPath = url.pathname && url.pathname !== '/' ? url.pathname : ''
      const filename = (url.hostname + rawPath).replace(/^\/+|\/+$/g, '')
      log.info(`[tour] parsed hostname=${url.hostname} pathname=${url.pathname} -> filename=${filename}`)
      if (!filename || filename.includes('..') || filename.includes('/')) {
        log.warn(`[tour] forbidden filename: ${filename}`)
        return new Response('forbidden', { status: 403 })
      }
      if (!videosRoot) {
        log.warn(`[tour] no videosRoot, cannot serve ${filename}`)
        return new Response('not found', { status: 404 })
      }
      const filePath = join(videosRoot, filename)
      if (!fs.existsSync(filePath)) {
        log.warn(`[tour] file missing: ${filePath}`)
        return new Response('not found', { status: 404 })
      }
      // Delegate to net.fetch with a file:// URL. Chromium's <video>
      // element wants byte-range responses to start playback (otherwise
      // the readyState stays at HAVE_NOTHING and onError fires after a
      // brief delay - which is exactly the "Clip not yet available"
      // fallback we kept hitting). net.fetch on file:// gives us range
      // support for free; our previous one-shot Uint8Array Response did
      // not.
      const fileUrl = 'file://' + filePath
      log.info(`[tour] serving ${filePath} via net.fetch`)
      const res = await net.fetch(fileUrl)
      log.info(`[tour] net.fetch returned status=${res.status} for ${filename}`)
      return res
    } catch (err) {
      log.error(`[tour] handler error: ${err}`)
      return new Response('error', { status: 500 })
    }
  })
}

// Smoke-test entrypoint. The build pipeline boots the packaged main bundle
// with `--smoke-test` to catch import-time failures (e.g. ERR_REQUIRE_ESM
// from an ESM-only dep that got externalized as CJS) before we cut a tag.
// Registered before the real whenReady handler so it fires first and
// terminates the process before any window/DB initialization runs.
if (process.argv.includes('--smoke-test')) {
  app.whenReady().then(() => {
    console.log('[smoke-test] main module loaded + app ready, exiting 0')
    app.exit(0)
  })
}

app.whenReady().then(() => {
  if (process.argv.includes('--smoke-test')) return

  // Send external links / OAuth opens from the embedded code-server <webview>
  // to the system browser. Electron silently blocks window.open in a <webview>
  // when allowpopups isn't honored, so the primary path overrides window.open
  // inside the guest and forwards the URL out via the console channel (a
  // preload with ipcRenderer.sendToHost would be cleaner if this turns flaky).
  // setWindowOpenHandler below is a fallback for non-window.open opens (anchor
  // target=_blank), gated by the allowpopups attribute set in IdePane.
  const OPEN_MARKER = '__SB_OPEN_EXTERNAL__'
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    contents.on('dom-ready', () => {
      contents
        .executeJavaScript(
          `(() => { if (window.__sbOpenHooked) return; window.__sbOpenHooked = true;
             window.open = (u) => { if (u) console.info(${JSON.stringify(OPEN_MARKER)} + u); return null; }; })()`,
        )
        .catch((err) => ideLog.warn('inject window.open hook failed', err))
    })
    contents.on('console-message', (_ev, _level, message) => {
      if (!message.startsWith(OPEN_MARKER)) return
      const url = message.slice(OPEN_MARKER.length)
      ideLog.info('window.open -> external', { url })
      if (/^https?:/.test(url)) shell.openExternal(url)
    })
    // Fallback for any window.open that does slip through natively.
    contents.setWindowOpenHandler(({ url }) => {
      ideLog.info('window.open (native) -> external', { url })
      if (/^https?:/.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
  })
  // Initialize database. getDb() self-heals a corrupt file (moves it aside,
  // recreates); if it still throws the disk itself is broken - tell the
  // user and quit instead of idling forever with no window.
  try {
    getDb()
  } catch (err) {
    console.error('[main] fatal: database unavailable', err)
    dialog.showErrorBox(
      'Switchboard could not start',
      `The local database could not be created:\n${err instanceof Error ? err.message : String(err)}\n\nCheck free disk space and permissions on the app data folder, then relaunch.`,
    )
    app.quit()
    return
  }
  registerTourProtocol()
  // Pull the known-projects list at request time (not registration time)
  // so newly added projects become servable without an app restart.
  registerFaviconProtocol(() => getProjects().map((p) => p.path))
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(
      join(app.getAppPath(), 'resources/icons/switchboard-logo-512.png')
    )
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon)
    }
  }

  // App menu - needed for ⌘, to reach the renderer
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow?.webContents.send('app:open-settings')
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => { void confirmReload(false) },
        },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => { void confirmReload(true) },
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  mainWindow = createWindow()

  // Handlers migrating to the BackendHost seam (remote-ready); rest take the window.
  // The mobile endpoint is ALWAYS in the fan-out; whether it actually listens is
  // decided by apply() from the saved token - and re-decided live whenever
  // Settings > Mobile saves, so a fresh QR is never a lie about a dead port.
  mobileEndpoint = new MobileEndpoint()
  const backendHost: BackendHost = new MultiHost(new ElectronIpcHost(mainWindow), mobileEndpoint)
  backendHost.handle(AppChannels.MOBILE_PAIRING_APPLY, () => mobileEndpoint!.apply())
  backendHost.handle(AppChannels.MOBILE_PAIRING_STATUS, () => mobileEndpoint!.status())
  // These sit behind the `admin` scope (see device-auth): a paired phone must
  // not be able to mint itself another session or revoke the devices that
  // could remove it.
  backendHost.handle(AppChannels.MOBILE_PAIRING_CODE, () => createPairingCode())
  backendHost.handle(AppChannels.MOBILE_DEVICES, () => listSessionViews())
  backendHost.handle(AppChannels.MOBILE_DEVICE_REVOKE, (id: string) => revokeSession(id))

  registerTerminalHandlers(backendHost)
  registerAgentHandlers(backendHost)
  registerAppHandlers(backendHost)
  registerPushHandlers(backendHost)
  registerAppDesktopHandlers(mainWindow)
  registerFilesHandlers(backendHost)
  registerGitHandlers(backendHost)
  registerIdeHandlers(backendHost)
  registerKanbanHandlers(backendHost)
  registerProviderInstanceHandlers(backendHost)
  // Local-only resolver: hand preload an instance's oauth_dir BASENAME (a path
  // segment, not a secret) so it can forward it to a remote at session start.
  // basename() runs on the desktop's OS, so a Windows path's backslashes are
  // handled correctly. Registered here (not in registerProviderInstanceHandlers,
  // which also runs on the remote WsHost) so it only serves the local DB.
  backendHost.handle(
    ProviderInstanceChannels.RESOLVE_OAUTH_DIR,
    (agentType: AgentType, instanceId: string | undefined) => {
      const dir = resolveProviderInstance(agentType, instanceId)?.oauthDir
      return dir ? basename(dir) : null
    },
  )
  registerMachineHandlers(backendHost)
  // Auto-update - silent check on launch when packaged. No-op in dev
  // because electron-updater requires a real built app to know what
  // version to compare against. See `src/main/updater.ts`.
  registerAutoUpdater(mainWindow)

  // Provider registry - new agent bridge (SDK-based)
  providerRegistry = new ProviderRegistry(backendHost)
  detachPush = attachPushNotifier(providerRegistry.bus)
  providerRegistry.registerIpcHandlers()

  // All handlers are recorded on the endpoint now; start listening if a token
  // is already saved. Later Settings saves re-apply() live over IPC.
  mobileEndpoint.apply()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      // Re-point the renderer half at the new window; the mobile endpoint is
      // already listening, so reuse it rather than binding the port again.
      const reactivatedHost: BackendHost = mobileEndpoint
        ? new MultiHost(new ElectronIpcHost(mainWindow), mobileEndpoint)
        : new ElectronIpcHost(mainWindow)
      registerTerminalHandlers(reactivatedHost)
      registerAgentHandlers(reactivatedHost)
      registerAppHandlers(reactivatedHost)
      registerPushHandlers(reactivatedHost)
      registerAppDesktopHandlers(mainWindow)
      registerFilesHandlers(reactivatedHost)
      registerGitHandlers(reactivatedHost)
      registerIdeHandlers(reactivatedHost)
      registerKanbanHandlers(reactivatedHost)
      registerMachineHandlers(reactivatedHost)
      registerAutoUpdater(mainWindow)

      providerRegistry = new ProviderRegistry(reactivatedHost)
      // New registry means a new bus. Without re-attaching, notifications stop
      // after the window has been closed and reopened once.
      detachPush?.()
      detachPush = attachPushNotifier(providerRegistry.bus)
      providerRegistry.registerIpcHandlers()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// PTYs first, and awaited - see shutdownTerminals for why the old
// synchronous kill still crashed on quit.
const quitCoordinator = new QuitCoordinator(
  async () => {
    await shutdownTerminals()
    providerRegistry?.stopAll()
    disposeUsageProbes()
    void stopAllMachineConnections()
    mobileEndpoint?.close()
    closeDb()
  },
  () => app.quit(),
)

app.on('before-quit', (event) => {
  if (quitCoordinator.handleBeforeQuit()) {
    event.preventDefault()
  }
})

// Prevent EPIPE crashes from killing the app
process.on('uncaughtException', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return // ignore broken pipe
  console.error('Uncaught:', err)
})

// Surface promise rejections that nobody awaited. Without this, an
// adapter or IPC handler that throws inside a fire-and-forget Promise
// vanishes silently — the bug shows up days later as "the UI just
// stopped updating" with zero log trail. We log and keep the process
// alive (Node's default may switch to crash-on-unhandled in future
// majors; explicit handler keeps behaviour predictable).
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
  console.error('Unhandled rejection:', msg)
})

import { app, BrowserWindow, shell, nativeImage, ipcMain, Menu, protocol, net } from 'electron'
import { join } from 'path'
import { registerTerminalHandlers } from './ipc/terminal'
import { registerAgentHandlers } from './ipc/agent'
import { registerAppHandlers } from './ipc/app'
import { registerFilesHandlers } from './ipc/files'
import { registerKanbanHandlers } from './ipc/kanban'
import { registerBranchesHandlers } from './ipc/branches'
import { registerProviderInstanceHandlers } from './ipc/providerInstances'
import { registerAutoUpdater, quitAndInstall } from './updater'
import { ProviderRegistry } from './provider/provider-registry'
import { getDb, closeDb, getSetting } from './db/database'
import { getLogDir, getLogFilePath, createMainLogger } from './logger'

const log = createMainLogger('tour')
import { AppChannels } from '@shared/ipc-channels'

let mainWindow: BrowserWindow | null = null
let providerRegistry: ProviderRegistry | null = null

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
])

// Single instance lock — prevent multiple windows
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function createWindow(): BrowserWindow {
  const iconPath = join(app.getAppPath(), 'resources/icons/switchboard-logo-1024.png')

  // Check saved theme so we can set vibrancy BEFORE window shows
  let savedTheme: string | null = null
  try { savedTheme = getSetting('theme') } catch { /* db not ready yet on first call */ }
  const isTranslucent = savedTheme === 'translucent'

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Switchboard',
    icon: nativeImage.createFromPath(iconPath),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: isTranslucent ? '#00000000' : '#0d1117',
    vibrancy: isTranslucent ? 'sidebar' : undefined,
    visualEffectState: 'active',
    transparent: isTranslucent,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

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

  // Intercept ⌘W / ⌘⇧W — renderer decides whether to close a tab, window, or app
  window.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'w' && input.type === 'keyDown') {
      event.preventDefault()
      window.webContents.send('app:close-pane-or-window', { shift: input.shift })
    }
  })

  // Renderer requests actual window close (after checking no panes to close)
  ipcMain.removeAllListeners('app:close-window')
  ipcMain.on('app:close-window', () => {
    window.close()
  })

  // Quit + relaunch into a downloaded update. Renderer fires this when
  // the user clicks "Restart to update" after the updater reports
  // `downloaded`.
  ipcMain.removeAllListeners('app:quit-and-install')
  ipcMain.on('app:quit-and-install', () => {
    quitAndInstall()
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
    } catch { /* EPIPE if stdout is closed — ignore */ }
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
 * Falls through to a 404 if the file doesn't exist — the renderer's
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
  log.info(`[tour] videosRoot = ${videosRoot ?? '(none found)'} — searched: ${roots.join(' | ')}`)

  protocol.handle('sb-tour', async (request) => {
    log.info(`[tour] request: ${request.url}`)
    try {
      const url = new URL(request.url)
      // `new URL('sb-tour://welcome.mp4')` parses welcome.mp4 as the
      // hostname (with a trailing pathname of '/'), NOT as the path.
      // Concatenating hostname+pathname therefore yields 'welcome.mp4/'
      // — a string with a slash, which our old guard then rejected as
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
      // brief delay — which is exactly the "Clip not yet available"
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
  // Initialize database
  getDb()
  registerTourProtocol()
  if (process.platform === 'darwin') {
    const dockIcon = nativeImage.createFromPath(
      join(app.getAppPath(), 'resources/icons/switchboard-logo-512.png')
    )
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon)
    }
  }

  // App menu — needed for ⌘, to reach the renderer
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
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

  mainWindow = createWindow()

  registerTerminalHandlers(mainWindow)
  registerAgentHandlers(mainWindow)
  registerAppHandlers(mainWindow)
  registerFilesHandlers()
  registerKanbanHandlers()
  registerBranchesHandlers(mainWindow)
  registerProviderInstanceHandlers()
  // Auto-update — silent check on launch when packaged. No-op in dev
  // because electron-updater requires a real built app to know what
  // version to compare against. See `src/main/updater.ts`.
  registerAutoUpdater(mainWindow)

  // Provider registry — new agent bridge (SDK-based)
  providerRegistry = new ProviderRegistry(mainWindow)
  providerRegistry.registerIpcHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      registerTerminalHandlers(mainWindow)
      registerAgentHandlers(mainWindow)
      registerAppHandlers(mainWindow)
      registerFilesHandlers()
      registerKanbanHandlers()
      registerBranchesHandlers(mainWindow)
      registerAutoUpdater(mainWindow)

      providerRegistry = new ProviderRegistry(mainWindow)
      providerRegistry.registerIpcHandlers()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  providerRegistry?.stopAll()
  closeDb()
})

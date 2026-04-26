/**
 * Auto-update wiring on top of electron-updater.
 *
 * Behavior:
 * - On launch (packaged builds only), kick off a background check.
 *   electron-updater fetches `latest-mac.yml` / `latest.yml` from the
 *   GitHub Release matching the configured publish block and compares
 *   against the running version. If newer, it downloads in the
 *   background and surfaces an `update-downloaded` event.
 * - Renderer can also trigger a check manually via the
 *   `app:check-for-updates` IPC channel (Settings → "Check for updates").
 * - All updater lifecycle events get forwarded to the renderer as
 *   `app:update-status` messages so the UI can render a small status
 *   line ("idle", "checking", "available", "downloaded", "up-to-date",
 *   "error").
 *
 * Macos unsigned caveat: Gatekeeper re-quarantines each update. Users
 * will need to right-click → Open (or run `xattr -d
 * com.apple.quarantine /Applications/Switchboard.app`) on each new
 * version. We accept this until we have an Apple Developer cert.
 *
 * The module is intentionally tiny — most logic lives inside
 * electron-updater itself. We just adapt the events to our IPC shape.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { AppChannels } from '@shared/ipc-channels'
import type { UpdateStatus } from '@shared/update-status'
import { createMainLogger } from './logger'

const log = createMainLogger('updater')

// Re-export for callers that reach into main directly.
export type { UpdateStatus }

let registered = false
let lastStatus: UpdateStatus = { kind: 'idle' }

function send(window: BrowserWindow, status: UpdateStatus): void {
  lastStatus = status
  if (!window.isDestroyed()) {
    window.webContents.send(AppChannels.UPDATE_STATUS, status)
  }
}

export function registerAutoUpdater(window: BrowserWindow): void {
  // Idempotent — `app.on('activate', ...)` calls this on macOS reopens.
  // Without the guard each window-recreate adds another set of
  // autoUpdater listeners and the renderer would see duplicate events.
  if (registered) return
  registered = true

  // Always register the IPC handler — even in dev — so the Settings
  // button has something to invoke. In dev it returns the
  // "unsupported" status instead of crashing.
  ipcMain.removeHandler(AppChannels.CHECK_FOR_UPDATES)
  ipcMain.handle(AppChannels.CHECK_FOR_UPDATES, async () => {
    if (!app.isPackaged) {
      const status: UpdateStatus = {
        kind: 'unsupported',
        reason: 'Auto-update is only available in packaged builds.',
      }
      send(window, status)
      return status
    }
    try {
      send(window, { kind: 'checking' })
      const result = await autoUpdater.checkForUpdates()
      // No `result` means the channel file was missing or unreachable;
      // electron-updater logs the underlying reason. Surface as error.
      if (!result) {
        send(window, { kind: 'error', message: 'Could not reach update server' })
      }
      return lastStatus
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`checkForUpdates failed: ${message}`)
      send(window, { kind: 'error', message })
      return lastStatus
    }
  })

  // Skip the actual updater in dev — autoUpdater throws or no-ops with
  // confusing messages when there's no `app-update.yml` next to the
  // executable.
  if (!app.isPackaged) {
    log.info('skipping autoUpdater wiring in dev mode')
    return
  }

  autoUpdater.autoDownload = true
  // Don't auto-install on quit — let the user click the prompt so a
  // long-running terminal pane doesn't die in the middle of work.
  autoUpdater.autoInstallOnAppQuit = false
  // Pipe the library's logger through ours so failures show up in the
  // app's log file, not just stdout.
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`[updater] ${String(m)}`),
    warn: (m: unknown) => log.warn(`[updater] ${String(m)}`),
    error: (m: unknown) => log.error(`[updater] ${String(m)}`),
    debug: (m: unknown) => log.info(`[updater:debug] ${String(m)}`),
  }

  autoUpdater.on('checking-for-update', () => send(window, { kind: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    send(window, { kind: 'available', version: info?.version ?? 'unknown' }),
  )
  autoUpdater.on('update-not-available', (info) =>
    send(window, { kind: 'up-to-date', version: info?.version ?? app.getVersion() }),
  )
  autoUpdater.on('download-progress', (p) =>
    send(window, { kind: 'downloading', percent: Math.round(p.percent ?? 0) }),
  )
  autoUpdater.on('update-downloaded', (info) =>
    send(window, { kind: 'downloaded', version: info?.version ?? 'unknown' }),
  )
  autoUpdater.on('error', (err) =>
    send(window, { kind: 'error', message: err.message ?? String(err) }),
  )

  // Kick off the initial check after a short delay so the renderer has
  // time to subscribe to status events. Otherwise the first
  // `checking-for-update` event fires before the listener is attached
  // and the UI looks stuck on "idle".
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn(`initial checkForUpdates failed: ${err instanceof Error ? err.message : err}`)
    })
  }, 3_000)
}

/**
 * Trigger the actual install. Called from a renderer button after
 * `update-downloaded` fires. Quits the app and restarts into the new
 * version.
 */
export function quitAndInstall(): void {
  if (!app.isPackaged) return
  autoUpdater.quitAndInstall()
}

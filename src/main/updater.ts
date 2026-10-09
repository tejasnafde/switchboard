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
 * The module is intentionally tiny - most logic lives inside
 * electron-updater itself. We just adapt the events to our IPC shape.
 */
import { app, ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { AppChannels } from '@shared/ipc-channels'
import type { UpdateStatus } from '@shared/update-status'
import { withTimeout } from '@shared/promise-timeout'
import { createMainLogger } from './logger'
import { friendlyUpdateError, isStaleDownloadError, isCheckTimeout } from './updater-error'
import { noteQuitSource } from './quit-source'
import { startUpdateScheduler, type ScheduledCheckReason } from './updater-schedule'

const log = createMainLogger('updater')

// Re-export for callers that reach into main directly.
export type { UpdateStatus }

let registered = false
let lastStatus: UpdateStatus = { kind: 'idle' }
const updaterWindows = new Set<BrowserWindow>()
/** Guards the one-shot re-download after a purged staging file. */
let staleDownloadRetried = false
/** True for the duration of any checkForUpdates() call - manual, initial, or scheduled. */
let checkInFlight = false
/** Clears the hourly/resume scheduler. Set once registered, null after `stopAutoUpdaterScheduler`. */
let stopScheduler: (() => void) | null = null

/**
 * Backstop against a `checkForUpdates()` that never returns - not a verdict on
 * a slow one. Healthy checks take ~2s, but a stalled connect to
 * release-assets.githubusercontent.com (30s to 45s, both address families)
 * pushes a SUCCESSFUL check to ~77s, and 30s here reported that as an error.
 * electron-updater dedups concurrent checks, so the retry it invited inherited
 * the same in-flight request.
 */
const CHECK_TIMEOUT_MS = 120_000

/**
 * The one path every checkForUpdates() call goes through - manual, initial,
 * and the hourly/resume scheduler below - so `checkInFlight` covers all of
 * them and a scheduled tick never piles onto a check already running.
 */
function checkForUpdatesTracked(): ReturnType<typeof autoUpdater.checkForUpdates> {
  checkInFlight = true
  return withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS, 'Update check').finally(() => {
    checkInFlight = false
  })
}

function trackWindow(window: BrowserWindow): void {
  if (updaterWindows.has(window)) return
  updaterWindows.add(window)
  window.once('closed', () => updaterWindows.delete(window))
}

function send(status: UpdateStatus): void {
  lastStatus = status
  for (const window of updaterWindows) {
    if (!window.isDestroyed()) {
      window.webContents.send(AppChannels.UPDATE_STATUS, status)
    }
  }
}

export function registerAutoUpdater(window: BrowserWindow): void {
  trackWindow(window)
  // Idempotent - `app.on('activate', ...)` calls this on macOS reopens.
  // Without the guard each window-recreate adds another set of
  // autoUpdater listeners and the renderer would see duplicate events.
  if (registered) return
  registered = true

  // Always register the IPC handler - even in dev - so the Settings
  // button has something to invoke. In dev it returns the
  // "unsupported" status instead of crashing.
  ipcMain.removeHandler(AppChannels.CHECK_FOR_UPDATES)
  ipcMain.handle(AppChannels.CHECK_FOR_UPDATES, async () => {
    if (!app.isPackaged) {
      const status: UpdateStatus = {
        kind: 'unsupported',
        reason: 'Auto-update is only available in packaged builds.',
      }
      send(status)
      return status
    }
    try {
      send({ kind: 'checking' })
      // Timed so a stall is measurable. Healthy checks take ~2s; three stalls
      // (2026-08-07 x2, 08-08) each ran ~77s, the shape of a TCP connect that
      // black-holes until the OS gives up. electron-updater dedups concurrent
      // checks, so a retry click during a stall inherits the stuck request.
      const startedAt = Date.now()
      const result = await checkForUpdatesTracked()
      log.info(`manual update check resolved in ${Date.now() - startedAt}ms`)
      // No `result` means the channel file was missing or unreachable;
      // electron-updater logs the underlying reason. Surface as error.
      if (!result) {
        send({ kind: 'error', message: 'Could not reach update server' })
      }
      return lastStatus
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`checkForUpdates failed: ${message}`)
      send({
        kind: isCheckTimeout(message) ? 'slow' : 'error',
        message: friendlyUpdateError(message),
      })
      return lastStatus
    }
  })
  ipcMain.removeHandler(AppChannels.GET_UPDATE_STATUS)
  ipcMain.handle(AppChannels.GET_UPDATE_STATUS, () => lastStatus)

  // Skip the actual updater in dev - autoUpdater throws or no-ops with
  // confusing messages when there's no `app-update.yml` next to the
  // executable.
  if (!app.isPackaged) {
    log.info('skipping autoUpdater wiring in dev mode')
    return
  }

  autoUpdater.autoDownload = true
  // Don't auto-install on quit - let the user click the prompt so a
  // long-running terminal pane doesn't die in the middle of work.
  autoUpdater.autoInstallOnAppQuit = false
  // Differential download never paid off here: it either finds no previous
  // update.zip and falls back anyway, or (2026-08-07) burns ~12s of range
  // requests, fails on a sha512 mismatch, then full-downloads regardless.
  autoUpdater.disableDifferentialDownload = true
  // Pipe the library's logger through ours so failures show up in the
  // app's log file, not just stdout.
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`[updater] ${String(m)}`),
    warn: (m: unknown) => log.warn(`[updater] ${String(m)}`),
    error: (m: unknown) => log.error(`[updater] ${String(m)}`),
    debug: (m: unknown) => log.info(`[updater:debug] ${String(m)}`),
  }

  autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    send({ kind: 'available', version: info?.version ?? 'unknown' }),
  )
  autoUpdater.on('update-not-available', (info) =>
    send({ kind: 'up-to-date', version: info?.version ?? app.getVersion() }),
  )
  autoUpdater.on('download-progress', (p) =>
    send({ kind: 'downloading', percent: Math.round(p.percent ?? 0) }),
  )
  autoUpdater.on('update-downloaded', (info) => {
    // A download that completes re-arms the stale-cache retry below, so a
    // later update in the same session gets its own attempt.
    staleDownloadRetried = false
    send({ kind: 'downloaded', version: info?.version ?? 'unknown' })
  })
  autoUpdater.on('error', (err) => {
    const msg = err.message ?? String(err)
    // The staging file was purged mid-download (see isStaleDownloadError).
    // electron-updater has already emptied the pending dir by the time it
    // reports this, so a fresh check re-downloads cleanly. Retry once per
    // successful download so a genuinely broken cache can't loop forever.
    if (isStaleDownloadError(msg) && !staleDownloadRetried) {
      staleDownloadRetried = true
      log.warn('update staging file vanished mid-download - retrying once')
      send({ kind: 'checking' })
      checkForUpdatesTracked().catch((retryErr) => {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        log.error(`stale-download retry failed: ${retryMsg}`)
        send({ kind: 'error', message: friendlyUpdateError(retryMsg) })
      })
      return
    }
    send({ kind: 'error', message: friendlyUpdateError(msg) })
  })

  // Kick off the initial check after a short delay so the renderer has
  // time to subscribe to status events. Otherwise the first
  // `checking-for-update` event fires before the listener is attached
  // and the UI looks stuck on "idle".
  setTimeout(() => {
    checkForUpdatesTracked().catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`initial checkForUpdates failed: ${message}`)
      // Unstick the UI: without this, a hung launch-time check leaves the
      // Settings row on the "checking" status it broadcast at start.
      send({
        kind: isCheckTimeout(message) ? 'slow' : 'error',
        message: friendlyUpdateError(message),
      })
    })
  }, 3_000)

  startAutoUpdaterScheduler()
}

/**
 * A periodic (hourly) or resume-triggered check. Deliberately quiet on the
 * happy path - a routine check that finds nothing new logs nothing, so a
 * desktop left running for days doesn't fill the log with one line an hour.
 * Only a failure, or a no-result (unreachable server), gets a line; a found
 * update already reaches the renderer and the log via the event handlers
 * above and electron-updater's own wired-through logger.
 */
function runScheduledCheck(reason: ScheduledCheckReason): void {
  checkForUpdatesTracked()
    .then((result) => {
      if (!result) {
        log.warn(`${reason} update check: could not reach update server`)
        send({ kind: 'error', message: 'Could not reach update server' })
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`${reason} update check failed: ${message}`)
      send({
        kind: isCheckTimeout(message) ? 'slow' : 'error',
        message: friendlyUpdateError(message),
      })
    })
}

function startAutoUpdaterScheduler(): void {
  if (stopScheduler) return
  stopScheduler = startUpdateScheduler({
    getState: () => ({ checkInFlight, downloaded: lastStatus.kind === 'downloaded' }),
    runCheck: runScheduledCheck,
    onResume: (listener) => powerMonitor.on('resume', listener),
  })
}

/**
 * Stops the hourly/resume scheduler. Called from the app's ordered shutdown
 * sequence so the interval is cleared well before the process exits, rather
 * than relying only on its unref() to keep it from firing mid-teardown.
 */
export function stopAutoUpdaterScheduler(): void {
  stopScheduler?.()
  stopScheduler = null
}

/**
 * Restarts the scheduler after a quit that did not happen (e.g. an aborted
 * `quitAndInstall`, see `onRecovered` in src/main/index.ts) - teardown
 * already stopped it, and the app keeps running, so periodic checks must
 * resume for the rest of the session.
 */
export function resumeAutoUpdaterScheduler(): void {
  if (!app.isPackaged) return
  startAutoUpdaterScheduler()
}

/**
 * Trigger the actual install. Called from a renderer button after
 * `update-downloaded` fires. Quits the app and restarts into the new
 * version.
 */
export function quitAndInstall(): void {
  if (!app.isPackaged) return
  noteQuitSource('update-install')
  autoUpdater.quitAndInstall()
}

/** Record + broadcast a status, so a remounted Settings row sees it too. */
export function reportInstallStatus(window: BrowserWindow, status: UpdateStatus): void {
  trackWindow(window)
  send(status)
}

import type { BrowserWindow, RenderProcessGoneDetails } from 'electron'
import { createMainLogger } from './logger'

const log = createMainLogger('app:renderer-crash')

/** Reasons that leave a blank window. `clean-exit` and `killed` are deliberate. */
export const RELOAD_REASONS: ReadonlySet<RenderProcessGoneDetails['reason']> = new Set([
  'crashed',
  'oom',
  'abnormal-exit',
])

export const MAX_RELOADS = 3
export const RELOAD_WINDOW_MS = 60_000

/** The error page's Reload button navigates here; the window intercepts it. */
export const CRASH_RELOAD_URL = 'https://switchboard.invalid/reload'

/** Sliding window: true while fewer than `max` reloads ran in the last `windowMs`. */
export function createReloadLimiter(
  now: () => number = Date.now,
  max = MAX_RELOADS,
  windowMs = RELOAD_WINDOW_MS,
): () => boolean {
  let times: number[] = []
  return () => {
    const t = now()
    times = times.filter((at) => t - at < windowMs)
    if (times.length >= max) return false
    times.push(t)
    return true
  }
}

export const CRASH_PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Switchboard</title>
<style>body{font:14px system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:420px;text-align:center}button{font:inherit;padding:6px 16px;margin-top:12px}</style></head>
<body><main><h1>The window crashed</h1>
<p>It crashed several times in one minute. Running agents keep working. Reload to try again.</p>
<button onclick="location.href='${CRASH_RELOAD_URL}'">Reload</button></main></body></html>`

/** The app itself never loads a data: URL into its window, so one is the crash page. */
export function isCrashPage(window: BrowserWindow): boolean {
  return window.webContents.getURL().startsWith('data:')
}

/**
 * Reloads the window after a renderer crash, at most MAX_RELOADS times per
 * RELOAD_WINDOW_MS. Past the limit it shows a plain error page whose Reload
 * button runs `load`. Agents live in the main process, so they keep running.
 */
export function attachRendererCrashRecovery(
  window: BrowserWindow,
  load: () => void,
  now: () => number = Date.now,
): void {
  const allowReload = createReloadLimiter(now)
  const contents = window.webContents
  contents.on('render-process-gone', (_event, details) => {
    const fields = { reason: details.reason, exitCode: details.exitCode }
    if (!RELOAD_REASONS.has(details.reason) || window.isDestroyed()) {
      log.warn('renderer gone, no reload', fields)
      return
    }
    if (allowReload()) {
      log.warn('renderer gone, reloading', fields)
      contents.reload()
      return
    }
    log.error('renderer gone, reload limit reached, showing error page', fields)
    void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CRASH_PAGE_HTML)}`)
  })
  contents.on('will-navigate', (event, url) => {
    if (url !== CRASH_RELOAD_URL) return
    event.preventDefault()
    // A link to the sentinel inside the app (say, in a chat message) must not reload it.
    if (!isCrashPage(window)) return
    log.info('reload from crash page')
    load()
  })
}

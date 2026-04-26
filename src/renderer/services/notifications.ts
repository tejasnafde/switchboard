/**
 * Native-notification helper.
 *
 * Fires an OS notification when an agent's turn finishes while the user
 * isn't looking at that chat. Honors the `notificationsEnabled` setting
 * (default on) so users can silence all notifications from Settings.
 *
 * "Not looking at it" means any of:
 *   - The Electron window is not focused (`document.hasFocus() === false`)
 *   - The document is hidden (`document.visibilityState === 'hidden'`)
 *   - The finished turn belongs to a session that is NOT the currently-
 *     active one (user is typing in a different chat)
 *
 * Uses the browser Notification API which Electron translates to native
 * platform notifications on macOS/Windows/Linux.
 */

const SETTING_KEY = 'notificationsEnabled'

let cached: boolean | null = null

export async function areNotificationsEnabled(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    const raw = await window.api.settings.get(SETTING_KEY)
    cached = raw === null ? true : raw !== 'false'
  } catch {
    cached = true
  }
  return cached
}

export function invalidateNotificationCache() {
  cached = null
}

export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  cached = enabled
  try {
    await window.api.settings.set(SETTING_KEY, enabled ? 'true' : 'false')
  } catch {
    /* best-effort */
  }
}

/**
 * Fire a test notification — used by the Settings UI to let users verify
 * their OS-level permission grant and toggle state end-to-end. Bypasses
 * the "is user looking at the window" guard so the notification always
 * appears when possible.
 */
export async function fireTestNotification(): Promise<{ ok: boolean; reason?: string }> {
  if (!(await areNotificationsEnabled())) {
    return { ok: false, reason: 'Notifications disabled in Switchboard settings.' }
  }
  if (typeof Notification === 'undefined') {
    return { ok: false, reason: 'Notification API unavailable in this renderer.' }
  }
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'OS-level permission denied. Enable in macOS System Settings → Notifications → Switchboard.' }
  }
  if (Notification.permission === 'default') {
    try {
      const result = await Notification.requestPermission()
      if (result !== 'granted') {
        return { ok: false, reason: `Permission not granted (${result}).` }
      }
    } catch (err) {
      return { ok: false, reason: `Permission request failed: ${String(err)}` }
    }
  }
  try {
    const n = new Notification('Switchboard', {
      body: 'Test notification — Switchboard will notify you when an agent turn finishes in a backgrounded chat.',
      tag: 'switchboard.test',
    })
    n.onclick = () => { try { window.focus() } catch { /* ignore */ } n.close() }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `new Notification() threw: ${String(err)}` }
  }
}

/** Current permission state — exposed for Settings UI diagnostics. */
export function currentNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

/**
 * Fire a native notification for a finished turn.
 *
 * Silently no-ops if:
 *   - Notifications are disabled in settings
 *   - The window is focused AND the turn is for the active session (i.e.
 *     the user is already looking at the result)
 *   - Notification permission is denied
 */
export async function notifyTurnCompleted(opts: {
  sessionTitle: string
  projectName?: string
  agentLabel: string
  threadId: string
  activeSessionId: string | null
  onClick?: () => void
}): Promise<void> {
  const { sessionTitle, projectName, agentLabel, threadId, activeSessionId, onClick } = opts

  if (!(await areNotificationsEnabled())) return

  // Suppress notification when user is already looking at this chat.
  const windowFocused = document.hasFocus() && document.visibilityState === 'visible'
  const lookingAtThisChat = windowFocused && activeSessionId === threadId
  if (lookingAtThisChat) return

  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'denied') return
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission() } catch { /* ignore */ }
  }
  if (Notification.permission !== 'granted') return

  const titleParts: string[] = [agentLabel]
  if (projectName) titleParts.push(projectName)
  const title = titleParts.join(' · ')

  const notif = new Notification(title, {
    body: sessionTitle + ' — turn finished',
    silent: false,
    tag: `turn.${threadId}`, // coalesce multiple notifs for the same session
  })
  notif.onclick = () => {
    try { window.focus() } catch { /* ignore */ }
    onClick?.()
    notif.close()
  }
}

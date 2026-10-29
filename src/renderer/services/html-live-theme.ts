/** The app theme as an inline live page receives it (`--sb-*` variables). */
import { htmlLiveChartColors, type HtmlLiveTheme } from '@shared/html-live'

/**
 * A still image, the pane and a saved file have no window vibrancy behind
 * them, so the translucent theme's near-clear background would come out light
 * under white text. It takes the solid colours that theme uses in full screen
 * (global.css, data-fullscreen).
 */
export function htmlLiveTheme(): HtmlLiveTheme {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  const translucent = root.classList.contains('theme-translucent')
  return {
    scheme: root.classList.contains('theme-light') ? 'light' : 'dark',
    bg: translucent ? '#111111' : v('--bg-secondary'),
    surface: translucent ? '#1a1a1a' : v('--bg-tertiary'),
    text: v('--text-primary'),
    muted: v('--text-secondary'),
    border: v('--border-strong') || v('--border'),
    accent: v('--accent'),
    success: v('--success'),
    warning: v('--warning'),
    error: v('--error'),
    font: v('--font-sans'),
    mono: v('--font-mono'),
    radius: v('--radius'),
    chart: htmlLiveChartColors(v),
  }
}

/** Hex SHA-256 of the block source: the key its still image is stored under. */
export async function htmlLiveKey(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

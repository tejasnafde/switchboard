/** The app theme as an inline live page receives it (`--sb-*` variables). */
import type { HtmlLiveTheme } from '@shared/html-live'

export function htmlLiveTheme(): HtmlLiveTheme {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  return {
    scheme: root.classList.contains('theme-light') ? 'light' : 'dark',
    bg: v('--bg-secondary'),
    surface: v('--bg-tertiary'),
    text: v('--text-primary'),
    muted: v('--text-secondary'),
    border: v('--border-strong') || v('--border'),
    accent: v('--accent'),
    success: v('--success'),
    warning: v('--warning'),
    error: v('--error'),
    font: v('--font-sans'),
    mono: v('--font-mono'),
  }
}

/** Hex SHA-256 of the block source: the key its still image is stored under. */
export async function htmlLiveKey(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

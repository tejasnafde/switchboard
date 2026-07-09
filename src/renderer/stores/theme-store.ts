import { create } from 'zustand'
import { updateAllTerminalThemes } from '../services/terminal-registry'

export type ThemeName = 'dark' | 'light' | 'translucent' | 'system'

const SAVED = new Set<ThemeName>(['dark', 'light', 'translucent', 'system'])

// ponytail: prefers-color-scheme is binary, so 'system' resolves to dark/light only.
// translucent stays a manual choice.
function resolve(theme: ThemeName): 'dark' | 'light' | 'translucent' {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
}

function apply(theme: ThemeName) {
  const resolved = resolve(theme)
  document.documentElement.className = `theme-${resolved}`
  // Mirror for the pre-paint script in index.html (kills the dark first-frame
  // flash before the async settings-DB read lands).
  try { localStorage.setItem('sb-theme', resolved) } catch { /* quota / private mode - flash is cosmetic */ }
  updateAllTerminalThemes()
  window.api?.app?.setVibrancy?.(resolved === 'translucent').catch(() => {})
}

interface ThemeStore {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void
  loadSavedTheme: () => void
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: 'dark',

  setTheme: (theme) => {
    apply(theme)
    set({ theme })
    window.api?.settings?.set('theme', theme).catch(() => {})
  },

  loadSavedTheme: () => {
    window.api?.settings?.get('theme').then((saved: string | null) => {
      if (saved && SAVED.has(saved as ThemeName)) {
        apply(saved as ThemeName)
        set({ theme: saved as ThemeName })
      }
    }).catch(() => {})
  },
}))

// Re-apply when the OS appearance flips, but only while following the system.
if (typeof window !== 'undefined') {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (useThemeStore.getState().theme === 'system') apply('system')
  })
}

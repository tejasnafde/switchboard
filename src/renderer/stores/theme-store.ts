import { create } from 'zustand'
import { updateAllTerminalThemes } from '../services/terminal-registry'

export type ThemeName = 'dark' | 'light' | 'translucent'

interface ThemeStore {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void
  loadSavedTheme: () => void
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: 'dark',

  setTheme: (theme) => {
    document.documentElement.className = `theme-${theme}`
    updateAllTerminalThemes()
    set({ theme })
    window.api?.app?.setVibrancy?.(theme === 'translucent').catch(() => {})
    window.api?.settings?.set('theme', theme).catch(() => {})
  },

  loadSavedTheme: () => {
    window.api?.settings?.get('theme').then((saved: string | null) => {
      if (saved && (saved === 'dark' || saved === 'light' || saved === 'translucent')) {
        document.documentElement.className = `theme-${saved}`
        updateAllTerminalThemes()
        set({ theme: saved as ThemeName })
        if (saved === 'translucent') {
          window.api?.app?.setVibrancy?.(true).catch(() => {})
        }
      }
    }).catch(() => {})
  },
}))

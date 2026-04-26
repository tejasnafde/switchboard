import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useThemeStore } from '../../src/renderer/stores/theme-store'

// Mock terminal-registry since it references DOM/xterm
vi.mock('../../src/renderer/services/terminal-registry', () => ({
  updateAllTerminalThemes: vi.fn(),
}))

// Mock document.documentElement
const mockClassList = { className: '' }
Object.defineProperty(globalThis, 'document', {
  value: { documentElement: mockClassList },
  writable: true,
})

// Mock window.api for settings persistence
Object.defineProperty(globalThis, 'window', {
  value: {
    api: {
      settings: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue(null),
      },
    },
  },
  writable: true,
})

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'dark' })
    mockClassList.className = ''
  })

  it('should default to dark theme', () => {
    expect(useThemeStore.getState().theme).toBe('dark')
  })

  it('should update theme and set CSS class', () => {
    useThemeStore.getState().setTheme('light')
    expect(useThemeStore.getState().theme).toBe('light')
    expect(mockClassList.className).toBe('theme-light')
  })

  it('should cycle through all theme options', () => {
    const { setTheme } = useThemeStore.getState()

    setTheme('dark')
    expect(useThemeStore.getState().theme).toBe('dark')

    setTheme('light')
    expect(useThemeStore.getState().theme).toBe('light')

    setTheme('translucent')
    expect(useThemeStore.getState().theme).toBe('translucent')
  })
})

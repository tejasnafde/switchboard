// @vitest-environment jsdom
/**
 * A live page's still image, its pane copy and a saved file have no window
 * vibrancy behind them, so the translucent theme hands them solid colours.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { htmlLiveTheme } from '../../src/renderer/services/html-live-theme'

const root = document.documentElement

afterEach(() => {
  root.className = ''
  root.removeAttribute('style')
})

describe('htmlLiveTheme', () => {
  it('gives the translucent theme solid backgrounds', () => {
    root.className = 'theme-translucent'
    root.style.setProperty('--bg-secondary', 'rgba(0, 0, 0, 0.03)')
    root.style.setProperty('--bg-tertiary', 'rgba(255, 255, 255, 0.04)')
    expect(htmlLiveTheme()).toMatchObject({ scheme: 'dark', bg: '#111111', surface: '#1a1a1a' })
  })

  it('keeps the theme colours otherwise', () => {
    root.className = 'theme-dark'
    root.style.setProperty('--bg-secondary', '#161616')
    root.style.setProperty('--bg-tertiary', '#202020')
    expect(htmlLiveTheme()).toMatchObject({ bg: '#161616', surface: '#202020' })
  })
})

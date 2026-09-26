/**
 * While Settings records a shortcut, the app menu's items must not act on
 * their accelerators (⌘R would open the reload dialog mid-recording).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMenuCaptureActive, setMenuCapture, unlessCapturing } from '../../src/main/menu-capture'

afterEach(() => setMenuCapture(false))

describe('menu capture guard', () => {
  it('runs the handler normally and skips it while recording', () => {
    const reload = vi.fn()
    const click = unlessCapturing(reload)
    click()
    setMenuCapture(true)
    click()
    expect(isMenuCaptureActive()).toBe(true)
    setMenuCapture(false)
    click()
    expect(reload).toHaveBeenCalledTimes(2)
  })

  const main = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')

  it('wraps every click handler in the app menu', () => {
    const menu = main.slice(main.indexOf('function buildAppMenu'), main.indexOf('function applyKeyboardOverrides'))
    const clicks = [...menu.matchAll(/click: (\S+)/g)].map((m) => m[1])
    expect(clicks.length).toBeGreaterThan(0)
    expect(clicks.every((c) => c.startsWith('unlessCapturing('))).toBe(true)
  })

  it('clears capture when the page reloads, crashes or closes, and skips the ⌘W intercept while on', () => {
    expect(main).toContain("window.webContents.on('did-start-loading', endCapture)")
    expect(main).toContain("window.webContents.on('render-process-gone', endCapture)")
    expect(main).toContain("window.on('closed', endCapture)")
    expect(main).toMatch(/before-input-event[\s\S]{0,200}isMenuCaptureActive\(\)/)
  })
})

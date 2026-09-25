import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../e2e/visual-regressions.e2e.mjs', import.meta.url), 'utf8')

describe('visual regression harness safety', () => {
  it('owns a launched Electron process before waiting for its first window', () => {
    const launch = source.slice(source.indexOf('async function launchSwitchboard'), source.indexOf('function seedRecentConversations'))
    expect(launch.indexOf('app = instance')).toBeGreaterThanOrEqual(0)
    expect(launch.indexOf('app = instance')).toBeLessThan(launch.indexOf('instance.firstWindow'))
  })

  it('only seeds the SQLite fixture on the macOS run that exercises native glass', () => {
    const seed = source.slice(source.indexOf('function seedRecentConversations'), source.indexOf('\ntry {'))
    expect(seed).toMatch(/process\.platform !== 'darwin'/)
    expect(seed).not.toContain("'/usr/bin/sqlite3'")
  })

  it('compares identical app content with native vibrancy enabled and disabled', () => {
    expect(source).toMatch(/setVibrancy\(null\)[\s\S]*?plainCapture[\s\S]*?setVibrancy\('sidebar'\)/)
    expect(source).not.toContain("setAlwaysOnTop(true, 'screen-saver')")
  })

  it('reloads the renderer in fullscreen before checking its solid fallback', () => {
    const fullscreen = source.slice(source.indexOf('async function assertFullscreenFallback'), source.indexOf('async function closeApp'))
    expect(fullscreen).toContain('await win.reload()')
    expect(fullscreen).toMatch(/reload[\s\S]*?dataset\.fullscreen === 'true'/)
  })

  it('checks the production workspace organizer in every theme and across relaunch', () => {
    expect(source).toContain('async function assertWorkspaceOrganizer')
    expect(source).toContain("for (const themeName of ['Dark', 'Light', 'Translucent'])")
    expect(source).toContain('workspace order did not persist across relaunch')
    expect(source).toContain("getByRole('button', { name: 'Skip tour' })")
  })

  it('captures the key screens in every theme, each from a pristine fixture', () => {
    expect(source).toContain("const THEMES = ['Dark', 'Light', 'Translucent']")
    const screens = [...source.matchAll(/snapScreen\(win, '([a-z-]+)'/g)].map((match) => match[1])
    expect(new Set(screens)).toEqual(new Set([
      'chat', 'sidebar', 'sidebar-needs-you', 'command-palette', 'provider-picker', 'settings', 'settings-accounts', 'kanban', 'approval', 'composer-running', 'queued-message', 'chat-narrow', 'confirm-dialog',
    ]))
    const run = source.slice(source.indexOf('async function runThemeScreens'))
    expect(run).toMatch(/for \(const theme of THEMES\) \{\s*fixture\.restore\(\)/)
  })

  it('freezes what varies between runs before capturing', () => {
    expect(source).toContain('addInitScript(pinDate, FROZEN_NOW)')
    expect(source).toContain("TZ: 'UTC'")
    expect(source).toContain('--force-device-scale-factor=1')
    expect(source).toMatch(/animation: none !important/)
    expect(source).toContain("caret: 'hide'")
  })

  it('removes every temp dir it creates on exit', () => {
    expect(source).not.toMatch(/mkdtempSync\(join\(tmpdir\(\), 'sb-/)
    expect(source).toContain("process.once('exit', cleanup)")
    expect(source).toMatch(/for \(const path of tempPaths\.splice\(0\)\) rmSync/)
  })
})

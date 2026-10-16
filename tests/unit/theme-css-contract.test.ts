import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './helpers/contrast'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
const desktopIpc = readFileSync(new URL('../../src/main/ipc/app-desktop.ts', import.meta.url), 'utf8')

function rule(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing selector: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

function exactRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = css.match(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1]
  if (!body) throw new Error(`missing exact selector: ${selector}`)
  return body
}

describe('theme CSS contracts', () => {
  it('creates a transparency-capable macOS window before a live theme switch', () => {
    expect(main).not.toMatch(/transparent:\s*isTranslucent/)
    expect(main).toMatch(/transparent:\s*process\.platform === 'darwin'/)
    expect(main).toMatch(/backgroundColor:\s*process\.platform === 'darwin'\s*\?\s*'#00000000'/)
    expect(main).toMatch(/vibrancy:\s*process\.platform === 'darwin'\s*\?\s*'sidebar'\s*:\s*undefined/)
    expect(main).not.toMatch(/process\.platform === 'darwin' && isTranslucent/)
    expect(main).toMatch(/process\.platform === 'darwin'[\s\S]*?webContents\.on\('did-finish-load'/)
    expect(main).toMatch(/did-finish-load[\s\S]*?window\.isFullScreen\(\)/)
    expect(main).toMatch(/did-finish-load[\s\S]*?app:fullscreen-changed/)
  })

  it('applies the resolved native theme and accounts for fullscreen switches', () => {
    expect(desktopIpc).not.toMatch(/enabled:\s*boolean/)
    expect(desktopIpc).toMatch(/theme:\s*'dark'\s*\|\s*'light'\s*\|\s*'translucent'/)
    expect(desktopIpc).toMatch(/window\.isFullScreen\(\)/)
    expect(desktopIpc).not.toMatch(/setBackgroundColor\(theme === 'light'/)
    expect(desktopIpc).toMatch(/window\.setBounds\(\{ \.\.\.bounds, height: bounds\.height \+ 1 \}\)/)
    expect(desktopIpc).toMatch(/window\.setBounds\(bounds\)/)
    expect(main).toMatch(/setTimeout\(\(\) => restoreMacWindowGlass\(window\), 500\)/)
  })

  it('keeps the translucent renderer root transparent for native vibrancy', () => {
    expect(rule('.theme-translucent')).toMatch(/--bg-primary:\s*transparent/)
    expect(rule('html.theme-translucent #root')).toMatch(/background(?:-color)?:\s*transparent/)
  })

  it('paints every translucent surface solid while macOS is fullscreen', () => {
    expect(exactRule('html[data-fullscreen="true"].theme-translucent')).toMatch(/--bg-primary:\s*#0a0a0a/)
    expect(rule('html[data-fullscreen="true"].theme-translucent .sidebar-root')).toMatch(/background:\s*#111111/)
    expect(rule('html[data-fullscreen="true"].theme-translucent .titlebar-drag')).toMatch(/background:\s*#111111/)
  })

  it('keeps the translucent workspace crystal clear', () => {
    const translucent = rule('.theme-translucent')
    expect(translucent).toMatch(/--bg-secondary:\s*rgba\(0,\s*0,\s*0,\s*0\.03\)/)
    expect(translucent).toMatch(/--bg-surface:\s*rgba\(0,\s*0,\s*0,\s*0\.05\)/)
    expect(translucent).toMatch(/--terminal-bg:\s*rgba\(0,\s*0,\s*0,\s*0\.03\)/)
    expect(exactRule('.theme-translucent .sidebar-root')).toMatch(/background:\s*transparent\s*!important/)
    expect(exactRule('.theme-translucent .titlebar-drag')).toMatch(/background:\s*transparent\s*!important/)
    expect(css).toMatch(
      /\.sidebar-create-trigger,\s*\.sidebar-organize-btn\s*\{[^}]*background:\s*var\(--bg-tertiary\)/s,
    )
  })

  it('does not turn Full Access into an amber glowing control', () => {
    expect(css).not.toMatch(/\.runtime-mode-select\[data-runtime-mode='full-access'\]\s*\{[^}]*var\(--warning\)/s)
    expect(css).not.toMatch(/\.runtime-mode-select\[data-runtime-mode='full-access'\]\s*\{[^}]*box-shadow/s)
  })

  it('keeps meaningful muted dark-theme text at readable contrast', () => {
    const darkTheme = rule(':root, .theme-dark')
    const foreground = darkTheme.match(/--text-muted:\s*(#[0-9a-f]{6})/i)?.[1]
    const background = darkTheme.match(/--bg-primary:\s*(#[0-9a-f]{6})/i)?.[1]
    expect(foreground).toBeTruthy()
    expect(background).toBeTruthy()
    expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(4.5)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')

function rule(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`missing selector: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((part) => parseInt(part, 16) / 255) ?? []
  const [r, g, b] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return (light + 0.05) / (dark + 0.05)
}

describe('theme CSS contracts', () => {
  it('keeps the translucent renderer root transparent for native vibrancy', () => {
    expect(rule('.theme-translucent')).toMatch(/--bg-primary:\s*transparent/)
    expect(rule('html.theme-translucent #root')).toMatch(/background(?:-color)?:\s*transparent/)
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
    expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(4.5)
  })
})

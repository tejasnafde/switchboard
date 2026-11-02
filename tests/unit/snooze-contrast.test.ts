/**
 * Every text surface Snooze adds reads at 4.5:1 or better in dark and light:
 * the menu's times (resting and hovered item), the context submenu's times,
 * a woken row's title and "Woke", a snoozed row, the footer notice and
 * refusal line, the Snoozed header and the composer line.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './helpers/contrast'

const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/global.css'), 'utf8')
const themes = {
  dark: /^:root, \.theme-dark \{([^}]*)\}/m,
  light: /^\.theme-light\s*\{([^}]*)\}/m,
} as const

function body(theme: keyof typeof themes): string {
  const found = css.match(themes[theme])?.[1]
  if (!found) throw new Error(`missing ${theme} theme`)
  return found
}

function hex(theme: keyof typeof themes, name: string): string {
  const value = body(theme).match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))?.[1]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

/** The theme's `--bg-hover` (an rgba) painted over `bottom`. */
function hoveredOver(theme: keyof typeof themes, bottom: string): string {
  const m = body(theme).match(/--bg-hover:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)\s*;/)
  if (!m) throw new Error('missing --bg-hover')
  const alpha = Number(m[4])
  return `#${[1, 3, 5]
    .map((at, i) => Math.round(Number(m[i + 1]) * alpha + parseInt(bottom.slice(at, at + 2), 16) * (1 - alpha)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`
}

describe.each(Object.keys(themes) as (keyof typeof themes)[])('%s theme Snooze text', (theme) => {
  const get = (name: string) => hex(theme, name)
  const sidebar = get('--bg-secondary')
  const rows = [sidebar, hoveredOver(theme, sidebar), get('--bg-tertiary')]
  const menu = get('--bg-elevated')

  // Secondary, not muted: dark's muted is 4.0:1 on a hovered menu item.
  it('the menu and context submenu times read on the menu and on a hovered item', () => {
    for (const under of [menu, hoveredOver(theme, menu)])
      expect(contrastRatio(get('--text-secondary'), under)).toBeGreaterThanOrEqual(4.5)
  })

  it('a woken row, a snoozed row and its wake time read on every row surface', () => {
    for (const under of rows) {
      expect(contrastRatio(get('--text-primary'), under)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(get('--text-secondary'), under)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(get('--text-muted'), under)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('the footer notice, the refusal line and the Snoozed header read on the sidebar', () => {
    for (const name of ['--text-secondary', '--text-primary', '--text-muted', '--accent'])
      expect(contrastRatio(get(name), sidebar)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(get('--text-muted'), get('--bg-tertiary'))).toBeGreaterThanOrEqual(4.5)
  })

  it('the composer line reads on its surface', () => {
    for (const name of ['--text-primary', '--text-secondary'])
      expect(contrastRatio(get(name), get('--bg-secondary'))).toBeGreaterThanOrEqual(4.5)
  })

  it('the paint behind each new text is the one tested here', () => {
    const menuFile = readFileSync(resolve(__dirname, '../../src/renderer/components/ui/menu.tsx'), 'utf8')
    expect(menuFile).toContain('text-[var(--text-secondary)] [font-variant-numeric:tabular-nums]')
    expect(css).toMatch(/\.sidebar-context-hint \{\s*color: var\(--text-secondary\);/)
    expect(css).toMatch(/\.sidebar-inbox-notice \{[^}]*color: var\(--text-secondary\);/)
    expect(css).toMatch(
      /\.sidebar-recent-row\.woke \.sidebar-recent-title,\s*\.sidebar-recent-row\.woke \.sidebar-recent-time \{\s*color: var\(--text-primary\);/,
    )
  })
})

/**
 * Every text surface the Snooze presets editor adds reads at 4.5:1 or better
 * in dark and light: the row text, errors and same-minute warnings on the
 * card, the chips (resting and checked), the Undo notice, the status line
 * and help on the page, and the menu preview.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './helpers/contrast'

const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/global.css'), 'utf8')
const panel = readFileSync(resolve(__dirname, '../../src/renderer/components/settings/SnoozePresetsPanel.tsx'), 'utf8')
const themes = {
  dark: /^:root, \.theme-dark \{([^}]*)\}/m,
  light: /^\.theme-light\s*\{([^}]*)\}/m,
} as const

function hex(theme: keyof typeof themes, name: string): string {
  const body = css.match(themes[theme])?.[1]
  const value = body?.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))?.[1]
  if (!value) throw new Error(`missing ${name} in ${theme}`)
  return value
}

describe.each(Object.keys(themes) as (keyof typeof themes)[])('%s theme Snooze presets text', (theme) => {
  const get = (name: string) => hex(theme, name)
  const reads = (text: string, under: string) =>
    expect(contrastRatio(get(text), get(under))).toBeGreaterThanOrEqual(4.5)

  it('the row text, its errors and its same-minute warning read on the card', () => {
    for (const text of ['--text-primary', '--text-secondary', '--text-error', '--text-warning'])
      reads(text, '--bg-surface')
  })

  it('a chip reads resting on its track and checked on its raised fill', () => {
    reads('--text-secondary', '--bg-secondary')
    reads('--text-primary', '--bg-tertiary')
  })

  it('the Undo notice, the fields and the status line read where they sit', () => {
    reads('--text-primary', '--bg-secondary')
    for (const text of ['--text-secondary', '--text-error', '--text-muted']) reads(text, '--bg-primary')
  })

  it('the menu preview reads on the menu surface', () => {
    reads('--text-primary', '--bg-elevated')
    reads('--text-secondary', '--bg-elevated')
  })

  it('the paint behind each new text is the one tested here', () => {
    expect(panel).not.toMatch(/text-\[var\(--(warning|error)\)\]/)
    expect(panel).toContain("'bg-[var(--bg-tertiary)] font-[500] text-[var(--text-primary)]")
    expect(panel).toContain('rounded-[10px] border border-[var(--border)] bg-[var(--bg-surface)]')
    expect(panel).toContain('bg-[var(--bg-elevated)]')
  })
})

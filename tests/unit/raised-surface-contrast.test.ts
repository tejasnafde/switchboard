import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { initialsInk } from '../../src/shared/initials-ink'
import { contrastRatio } from './helpers/contrast'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')

function token(selector: RegExp, name: string): string {
  const body = css.match(selector)?.[1]
  if (!body) throw new Error(`missing rule ${selector}`)
  const value = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))?.[1]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

/** `top` at `alpha` over the opaque `bottom`. */
function over(top: string, alpha: number, bottom: string): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16)
  return `#${[1, 3, 5]
    .map((at) => Math.round(channel(top, at) * alpha + channel(bottom, at) * (1 - alpha)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

/** The model picker's surface (.sb-provider-picker) over the window. */
const pickerSurface = {
  dark: (primary: string) => over('#16161a', 0.94, primary),
  light: (primary: string) => over('#ffffff', 0.96, primary),
}

const themes = {
  dark: /^:root, \.theme-dark \{([^}]*)\}/m,
  light: /^\.theme-light\s*\{([^}]*)\}/m,
} as const

describe.each(Object.keys(themes) as (keyof typeof themes)[])(
  '%s theme text on raised and selected surfaces',
  (theme) => {
    const get = (name: string) => token(themes[theme], name)

    it.each(['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-elevated'])(
      'muted text reads at 4.5:1 or better on %s',
      (surface) => {
        expect(contrastRatio(get('--text-muted'), get(surface))).toBeGreaterThanOrEqual(4.5)
      },
    )

    // The chat Details popover (sb-floating-surface paints --bg-elevated).
    it.each(['--text-success', '--text-warning', '--text-error'])(
      '%s reads at 4.5:1 or better on --bg-elevated',
      (name) => {
        expect(contrastRatio(get(name), get('--bg-elevated'))).toBeGreaterThanOrEqual(4.5)
      },
    )

    it('muted text reads at 4.5:1 or better on the model picker', () => {
      expect(contrastRatio(get('--text-muted'), pickerSurface[theme](get('--bg-primary')))).toBeGreaterThanOrEqual(4.5)
    })

    // A selected picker row is 14 % accent over the picker, a hovered row
    // --bg-tertiary; the model id on them is --text-secondary, not muted.
    it('secondary text reads at 4.5:1 or better on a selected and a hovered picker row', () => {
      const picker = pickerSurface[theme](get('--bg-primary'))
      for (const row of [over(get('--accent'), 0.14, picker), get('--bg-tertiary')])
        expect(contrastRatio(get('--text-secondary'), row)).toBeGreaterThanOrEqual(4.5)
    })
  },
)

describe('initialsInk', () => {
  it.each(['#ff8a3d', '#3da8ff', '#7c5cff', '#3dd17a', '#ff5ca8', '#ffd23d', '#d97757', '#1f6feb', '#2563eb'])(
    'reads at 4.5:1 or better on %s',
    (fill) => {
      expect(contrastRatio(initialsInk(fill) === '#fff' ? '#ffffff' : '#000000', fill)).toBeGreaterThanOrEqual(4.5)
    },
  )
})

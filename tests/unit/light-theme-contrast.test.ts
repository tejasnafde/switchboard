import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './helpers/contrast'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')

function lightToken(name: string): string {
  const body = css.match(/^\.theme-light\s*\{([^}]*)\}/m)?.[1]
  if (!body) throw new Error('missing .theme-light rule')
  const value = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))?.[1]
  if (!value) throw new Error(`missing ${name} in .theme-light`)
  return value
}

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })

  it('rejects colours it cannot measure', () => {
    expect(() => contrastRatio('rgba(0,0,0,0.5)', '#ffffff')).toThrow()
  })
})

describe('light theme muted text', () => {
  it.each(['--bg-primary', '--bg-secondary'])('reads at 4.5:1 or better on %s', (background) => {
    expect(contrastRatio(lightToken('--text-muted'), lightToken(background))).toBeGreaterThanOrEqual(4.5)
  })
})

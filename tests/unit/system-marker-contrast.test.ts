import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './helpers/contrast'

const css = readFileSync(new URL('../../src/renderer/styles/global.css', import.meta.url), 'utf8')
const bubble = readFileSync(new URL('../../src/renderer/components/chat/MessageBubble.tsx', import.meta.url), 'utf8')

function token(selector: RegExp, name: string): string {
  const body = css.match(selector)?.[1]
  if (!body) throw new Error(`missing rule ${selector}`)
  const value = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))?.[1]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const THEMES = { dark: /^:root, \.theme-dark\s*\{([^}]*)\}/m, light: /^\.theme-light\s*\{([^}]*)\}/m }

describe('rotation and notice marker', () => {
  it.each(Object.entries(THEMES))('reads at 4.5:1 or better in %s', (_, rule) => {
    expect(contrastRatio(token(rule, '--text-secondary'), token(rule, '--bg-secondary'))).toBeGreaterThanOrEqual(4.5)
  })

  it('paints only theme variables that exist, at full opacity', () => {
    expect(bubble).not.toMatch(/var\(--sb-|var\(--danger/)
    expect(bubble).not.toMatch(/opacity: 0\.78/)
  })
})

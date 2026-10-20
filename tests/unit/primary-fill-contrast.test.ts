/** White text on the filled primary button reads at 4.5:1 or better, at rest and on hover. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio } from './helpers/contrast'

const tailwind = readFileSync(join(__dirname, '../../src/renderer/styles/tailwind.css'), 'utf8')
const button = readFileSync(join(__dirname, '../../src/renderer/components/ui/button.tsx'), 'utf8')

describe('primary button fill', () => {
  it.each(['--color-primary-fill', '--color-primary-fill-hover'])(
    '%s is a fixed colour white text reads on',
    (token) => {
      const fill = new RegExp(`${token}:\\s*(#[0-9a-f]{6});`, 'i').exec(tailwind)?.[1]
      expect(fill).toBeDefined()
      expect(contrastRatio('#ffffff', fill!)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('is what the default variant paints', () => {
    expect(button).toContain("default: 'bg-primary-fill text-primary-foreground hover:bg-primary-fill-hover'")
  })
})

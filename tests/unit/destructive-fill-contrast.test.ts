/** White text on the filled destructive button reads at 4.5:1 or better. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio } from './helpers/contrast'

const tailwind = readFileSync(join(__dirname, '../../src/renderer/styles/tailwind.css'), 'utf8')
const button = readFileSync(join(__dirname, '../../src/renderer/components/ui/button.tsx'), 'utf8')

describe('destructive button fill', () => {
  it('is a fixed colour white text reads on', () => {
    const fill = /--color-destructive-fill:\s*(#[0-9a-f]{6});/i.exec(tailwind)?.[1]
    expect(fill).toBeDefined()
    expect(contrastRatio('#ffffff', fill!)).toBeGreaterThanOrEqual(4.5)
  })

  it('is what the destructive variant paints', () => {
    expect(button).toContain("destructive: 'bg-destructive-fill text-destructive-foreground")
  })
})

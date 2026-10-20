/** White text and marks on the primary fill read at 4.5:1 or better: the button at rest and on hover, the checked checkbox, the radio dot. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contrastRatio } from './helpers/contrast'

const tailwind = readFileSync(join(__dirname, '../../src/renderer/styles/tailwind.css'), 'utf8')
const ui = (name: string) => readFileSync(join(__dirname, `../../src/renderer/components/ui/${name}`), 'utf8')
const button = ui('button.tsx')

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

  it('fills the checked checkbox under its white check mark, and the radio dot', () => {
    expect(ui('checkbox.tsx')).toContain(
      'data-[state=checked]:border-primary-fill data-[state=checked]:bg-primary-fill',
    )
    expect(ui('radio-group.tsx')).toContain('rounded-full bg-primary-fill')
  })
})

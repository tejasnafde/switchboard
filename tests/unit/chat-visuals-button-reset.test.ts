import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Tailwind runs without preflight, so a <button> keeps the browser's grey fill
// and outset border unless its classes set a background and a border.
const dir = new URL('../../src/renderer/components/chat/visuals/', import.meta.url)

function buttonClasses(source: string): string[] {
  return [...source.matchAll(/<button\b[^>]*?className=(?:"([^"]*)"|\{(\w+)\})/g)].map(([, literal, name]) => {
    if (literal !== undefined) return literal
    const decl = source.match(new RegExp(`const ${name} =\\s*'([^']*)'`))
    if (!decl) throw new Error(`className constant ${name} not found`)
    return decl[1]
  })
}

describe('chat visual buttons', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'))

  it.each(files)('%s sets a background and a border style on every <button>', (file) => {
    for (const cls of buttonClasses(readFileSync(new URL(file, dir), 'utf8'))) {
      expect(cls, cls).toMatch(/(^|\s)bg-/)
      expect(cls, cls).toMatch(/(^|\s)(border|border-0|border-solid)(\s|$)/)
    }
  })
})

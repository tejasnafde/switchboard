/**
 * Tailwind scans only components/ui and the files listed with @source in
 * styles/tailwind.css. A utility class in any other file generates no CSS and
 * the element renders unstyled with no build error, so every renderer file
 * that uses one must be on the list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const renderer = resolve(__dirname, '../../src/renderer')
const stylesDir = join(renderer, 'styles')
const tailwindCss = readFileSync(join(stylesDir, 'tailwind.css'), 'utf8')
const sources = [...tailwindCss.matchAll(/@source '([^']+)';/g)].map((m) => resolve(stylesDir, m[1]))

// An arbitrary-value utility such as text-[11px] or bg-[var(--border)]. The
// app's own class names never contain brackets.
const ARBITRARY_UTILITY = /\b[a-z][a-z0-9-]*-\[[^\]\s'"]+\]/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('tailwind @source list', () => {
  it('lists every existing file', () => {
    for (const source of sources) expect(() => statSync(source), relative(renderer, source)).not.toThrow()
  })

  it('covers every renderer file that uses an arbitrary-value utility', () => {
    const covered = (file: string) => sources.some((source) => file === source || file.startsWith(source + '/'))
    const missing = walk(renderer)
      .filter((file) => ARBITRARY_UTILITY.test(readFileSync(file, 'utf8')))
      .filter((file) => !covered(file))
      .map((file) => relative(renderer, file))
    expect(missing).toEqual([])
  })
})

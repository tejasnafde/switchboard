/**
 * Tailwind scans only components/ui and the files listed with @source in
 * styles/tailwind.css. A utility class in any other file generates no CSS and
 * the element renders unstyled with no build error, so every renderer file
 * that uses one must be on the list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
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

type PathApi = Pick<typeof posix, 'relative' | 'isAbsolute'>

/** A file is covered when it is a listed file or sits under a listed directory. */
function isCovered(file: string, source: string, path: PathApi): boolean {
  const rel = path.relative(source, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

describe('isCovered', () => {
  // CI runs on Windows too, where node:path joins with backslashes.
  for (const [name, path, root] of [['posix', posix, '/repo/src/renderer'], ['win32', win32, 'C:\\repo\\src\\renderer']] as const) {
    it(`matches listed files and directories with ${name} paths`, () => {
      const ui = path.join(root, 'components', 'ui')
      const picker = path.join(root, 'components', 'chat', 'Picker.tsx')
      expect(isCovered(path.join(ui, 'button.tsx'), ui, path)).toBe(true)
      expect(isCovered(picker, picker, path)).toBe(true)
      expect(isCovered(path.join(root, 'components', 'uix', 'a.tsx'), ui, path)).toBe(false)
      expect(isCovered(path.join(root, 'components', 'chat', 'Other.tsx'), picker, path)).toBe(false)
    })
  }
})

describe('tailwind @source list', () => {
  it('lists every existing file', () => {
    for (const source of sources) expect(() => statSync(source), relative(renderer, source)).not.toThrow()
  })

  it('covers every renderer file that uses an arbitrary-value utility', () => {
    const covered = (file: string) => sources.some((source) => isCovered(file, source, { relative, isAbsolute }))
    const missing = walk(renderer)
      .filter((file) => ARBITRARY_UTILITY.test(readFileSync(file, 'utf8')))
      .filter((file) => !covered(file))
      .map((file) => relative(renderer, file).split('\\').join('/'))
    expect(missing).toEqual([])
  })
})

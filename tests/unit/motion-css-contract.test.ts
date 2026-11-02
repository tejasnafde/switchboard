import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = new URL('../../src/renderer/', import.meta.url).pathname
const css = readFileSync(join(root, 'styles/global.css'), 'utf8')
const read = (file: string): string => readFileSync(join(root, file), 'utf8')

function reducedMotionBlocks(): string {
  const blocks: string[] = []
  const re = /@media \(prefers-reduced-motion: reduce\) \{/g
  for (let match = re.exec(css); match; match = re.exec(css)) {
    let depth = 1
    let at = match.index + match[0].length
    while (depth > 0 && at < css.length) {
      if (css[at] === '{') depth++
      if (css[at] === '}') depth--
      at++
    }
    blocks.push(css.slice(match.index, at))
  }
  return blocks.join('\n')
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return tsxFiles(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

describe('popover, menu and dialog motion', () => {
  it('opens in 150 ms and closes in 100 ms with fade and scale from 0.98', () => {
    expect(css).toMatch(/@keyframes sb-pop-in \{\s*from \{ opacity: 0; transform: scale\(0\.98\); \}/)
    expect(css).toMatch(/@keyframes sb-pop-out \{\s*to \{ opacity: 0; transform: scale\(0\.98\); \}/)
    expect(css).toMatch(/\.sb-pop\[data-state='open'\] \{\s*animation: sb-pop-in 150ms ease-out;/)
    expect(css).toMatch(/\.sb-pop\[data-state='closed'\] \{\s*animation: sb-pop-out 100ms ease-out forwards;\s*pointer-events: none;/)
    expect(css).toMatch(/\.sb-pop-anchored \{\s*transform-origin: var\(--radix-popover-content-transform-origin\);/)
  })

  it('puts the motion on every popover and dialog primitive', () => {
    expect(read('components/ui/popover.tsx')).toContain("'sb-pop sb-pop-anchored")
    expect(read('components/ui/dialog.tsx')).toContain("'sb-pop fixed")
    expect(read('components/ui/alert-dialog.tsx')).toContain("'sb-pop sb-floating-surface")
  })

  it('stops the motion and every transition class under reduced motion', () => {
    const reduce = reducedMotionBlocks()
    expect(reduce).toMatch(/\.sb-pop\[data-state\] \{\s*animation: none;/)
    for (const name of css.match(/^\.sb-tr-[a-z]+(?= \{)/gm) ?? []) expect(reduce).toContain(name)
  })

  it('keeps transitions out of inline styles, where the media query cannot reach them', () => {
    const offenders = tsxFiles(root).filter((file) => /\btransition:\s*['`]/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => file.slice(root.length))).toEqual([])
  })

  it('has one spinner part', () => {
    const offenders = tsxFiles(root).filter(
      (file) => !file.endsWith('ui/spinner.tsx') && /\banimate-spin\b|sb-spin/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders.map((file) => file.slice(root.length))).toEqual([])
  })
})

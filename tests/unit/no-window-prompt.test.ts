/**
 * Guard: window.prompt() is a no-op in Electron renderers (returns null, opens
 * no dialog), so any rename/create flow built on it silently does nothing. This
 * shipped once (project rename via window.prompt). Ban real calls in the
 * renderer - comments/JSDoc mentioning it are fine. Use inline edit or
 * PromptModal instead.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const RENDERER = join(__dirname, '../../src/renderer')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

describe('no window.prompt in renderer', () => {
  it('has no real window.prompt() calls (Electron no-ops it)', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!isComment(line) && line.includes('window.prompt(')) {
          offenders.push(`${file}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

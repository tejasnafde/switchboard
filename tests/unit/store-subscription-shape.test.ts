/**
 * Components select the store fields they read. A bare `useXStore()` call
 * subscribes to the whole store, so any write anywhere re-renders the caller
 * (and, from App, the whole tree). Sidebar rows show time through
 * RelativeTimeLabel, never by reading the clock while they render.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const renderer = join(root, 'src/renderer')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

it('no renderer file subscribes to a whole store', () => {
  const offenders = walk(renderer)
    .filter((file) => /\buse[A-Z]\w*Store\(\s*\)/.test(readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')))
    .map((file) => relative(root, file))
  expect(offenders).toEqual([])
})

it('sidebar rows do not format relative time while they render', () => {
  const rows = ['Sidebar.tsx', 'MachineLayer.tsx', 'RecentSessionsSection.tsx'].map((name) =>
    readFileSync(join(renderer, 'components/sidebar', name), 'utf8'),
  )
  for (const source of rows) expect(source).not.toMatch(/formatRelativeTime\(/)
})

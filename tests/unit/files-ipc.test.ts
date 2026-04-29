/**
 * File-tree pane IPC primitives. Three concerns we want to lock down:
 *
 *   1. Listing annotates gitignored entries instead of filtering them, so
 *      the renderer can grey them out (VS Code style) while keeping them
 *      clickable.
 *   2. File reads enforce a byte cap so the viewer never OOMs on a 50 MB
 *      log dump — caller gets a `truncated:true` flag to render a banner.
 *   3. Parsed `.gitignore` rules are memoized by `(path, mtimeMs)` — so
 *      hot directories don't re-parse the same file on every tree expand.
 *      Cache invalidates as soon as the file is rewritten.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirAnnotated, readFileCapped, getCachedGitignore } from '../../src/main/files/listing'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sb-files-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('listDirAnnotated', () => {
  it('annotates gitignored entries without filtering them', async () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\n')
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'README.md'), '# hi')

    const entries = await listDirAnnotated(root, root)
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))

    expect(byName['node_modules']).toBeDefined()
    expect(byName['node_modules'].isGitignored).toBe(true)
    expect(byName['src'].isGitignored).toBe(false)
    expect(byName['README.md'].isGitignored).toBe(false)
  })

  it('marks directories with isDir:true', async () => {
    mkdirSync(join(root, 'pkg'))
    writeFileSync(join(root, 'a.txt'), 'x')
    const entries = await listDirAnnotated(root, root)
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(byName['pkg'].isDir).toBe(true)
    expect(byName['a.txt'].isDir).toBe(false)
  })
})

describe('readFileCapped', () => {
  it('returns full content under cap', async () => {
    const p = join(root, 'small.txt')
    writeFileSync(p, 'hello')
    const out = await readFileCapped(p, 1024)
    expect(out.content).toBe('hello')
    expect(out.truncated).toBe(false)
  })

  it('truncates content over cap and flags it', async () => {
    const p = join(root, 'big.txt')
    writeFileSync(p, 'x'.repeat(10_000))
    const out = await readFileCapped(p, 100)
    expect(out.content.length).toBe(100)
    expect(out.truncated).toBe(true)
  })
})

describe('getCachedGitignore', () => {
  it('returns the same parsed instance on identical (path, mtime)', async () => {
    const p = join(root, '.gitignore')
    writeFileSync(p, 'node_modules\n')
    const a = await getCachedGitignore(p)
    const b = await getCachedGitignore(p)
    expect(a).toBe(b) // referential equality — proves cache hit
  })

  it('reparses when mtime changes', async () => {
    const p = join(root, '.gitignore')
    writeFileSync(p, 'node_modules\n')
    const a = await getCachedGitignore(p)
    // bump mtime by rewriting; sleep ensures different mtimeMs on coarse FS
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(p, 'dist\n')
    const b = await getCachedGitignore(p)
    expect(a).not.toBe(b)
  })

  it('returns empty rule list when file is missing', async () => {
    const rules = await getCachedGitignore(join(root, 'nope.gitignore'))
    expect(rules).toEqual([])
  })
})

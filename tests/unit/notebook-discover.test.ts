import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverNotebooks } from '../../src/main/notebooks/discover'

let repo: string

const touch = (relPath: string): void => {
  const abs = join(repo, relPath)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, '{}')
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'sb-nbdiscover-test-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('discoverNotebooks', () => {
  it('finds .ipynb files recursively, repo-relative and sorted', () => {
    touch('b.ipynb')
    touch('reports/q3/a.ipynb')
    touch('src/app.ts')

    expect(discoverNotebooks(repo)).toEqual(['b.ipynb', 'reports/q3/a.ipynb'])
  })

  it('skips dependency, VCS, checkpoint and switchboard directories', () => {
    touch('real.ipynb')
    touch('node_modules/pkg/junk.ipynb')
    touch('.git/objects/fake.ipynb')
    touch('.venv/lib/site.ipynb')
    touch('venv/lib/site.ipynb')
    touch('.ipynb_checkpoints/real-checkpoint.ipynb')
    touch('.switchboard/notebooks/real.py')

    expect(discoverNotebooks(repo)).toEqual(['real.ipynb'])
  })

  it('caps the result set', () => {
    for (let i = 0; i < 8; i++) touch(`nb${i}.ipynb`)

    expect(discoverNotebooks(repo, { cap: 3 })).toHaveLength(3)
  })

  it('returns empty for a repo without notebooks (and for a missing dir)', () => {
    expect(discoverNotebooks(repo)).toEqual([])
    expect(discoverNotebooks(join(repo, 'nope'))).toEqual([])
  })
})

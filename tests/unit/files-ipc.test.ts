/**
 * Surviving files/listing.ts primitives after the CodeMirror-pane removal:
 *   - listAllFiles backs chat @-mention autocomplete
 *   - listDirEntries backs the remote add-project path autocomplete
 * Real tmp directories - pure I/O, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAllFiles, listDirEntries } from '../../src/main/files/listing'

describe('files listing', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-files-'))
    writeFileSync(join(root, 'a.ts'), 'a')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'b.ts'), 'b')
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  describe('listAllFiles', () => {
    it('walks recursively with repo-relative paths, skipping node_modules and .git', async () => {
      const files = await listAllFiles(root)
      expect(files.sort()).toEqual(['a.ts', 'src/b.ts'])
    })

    it('respects the cap', async () => {
      const files = await listAllFiles(root, 1)
      expect(files).toHaveLength(1)
    })
  })

  describe('listDirEntries', () => {
    it('lists names with isDir, directories first', async () => {
      const entries = await listDirEntries(root)
      expect(entries.map((e) => e.name)).toEqual(['node_modules', 'src', 'a.ts'])
      expect(entries[0].isDir).toBe(true)
      expect(entries[2].isDir).toBe(false)
    })

    it('throws on a missing directory (handler maps this to ok:false)', async () => {
      await expect(listDirEntries(join(root, 'missing'))).rejects.toThrow()
    })
  })
})

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'fs'
import {
  decodeCursorFileUri,
  cursorPathsEqual,
  workspaceStorageMatchesProject,
} from '../../src/main/cursor/workspace'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-cursor-workspace-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Cursor workspace matching', () => {
  it('decodes a local file URI without treating encoded separators as text', () => {
    expect(decodeCursorFileUri('file:///Users/tejas/My%20Project')).toBe('/Users/tejas/My Project')
    expect(decodeCursorFileUri('https://example.test/repo')).toBeNull()
  })

  it('matches a folder workspace by exact normalized path', () => {
    const storage = fixture()
    writeFileSync(join(storage, 'workspace.json'), JSON.stringify({
      folder: 'file:///Users/tejas/projects/switchboard',
    }))

    expect(workspaceStorageMatchesProject(storage, '/Users/tejas/projects/switchboard')).toBe(true)
    expect(workspaceStorageMatchesProject(storage, '/Users/tejas/projects/switchboard-child')).toBe(false)
  })

  it('normalizes separators and case on Windows without weakening POSIX matching', () => {
    expect(cursorPathsEqual('C:\\Users\\Tejas\\repo', 'c:/users/tejas/repo', 'win32')).toBe(true)
    expect(cursorPathsEqual('/Users/Tejas/repo', '/Users/tejas/repo', 'darwin')).toBe(false)
  })

  it('matches a project contained in a multi-root code workspace with comments', () => {
    const root = fixture()
    const storage = join(root, 'storage')
    const project = join(root, 'apps', 'web')
    const workspaceFile = join(root, 'team.code-workspace')
    mkdirSync(storage)
    mkdirSync(project, { recursive: true })
    writeFileSync(workspaceFile, `{
      // Cursor and VS Code permit JSON comments here.
      "folders": [
        { "path": "apps/web" },
        { "uri": "file:///Users/example/shared" }
      ]
    }`)
    writeFileSync(join(storage, 'workspace.json'), JSON.stringify({
      workspace: `file://${workspaceFile}`,
    }))

    expect(workspaceStorageMatchesProject(storage, project)).toBe(true)
    expect(workspaceStorageMatchesProject(storage, join(root, 'apps'))).toBe(false)
  })

  it('returns false for malformed or missing workspace metadata', () => {
    const missing = fixture()
    const malformed = fixture()
    writeFileSync(join(malformed, 'workspace.json'), '{')

    expect(workspaceStorageMatchesProject(missing, '/repo')).toBe(false)
    expect(workspaceStorageMatchesProject(malformed, '/repo')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import {
  LOCAL_MACHINE_ID,
  resolveExecutionRoot,
  sameExecutionRoot,
  normalizeRootPath,
  isPathWithinRoot,
  rebaseWithinRoot,
  describeExecutionRoot,
} from '../../src/shared/execution-root'

describe('resolveExecutionRoot', () => {
  it('falls back to the project path when no worktree is set', () => {
    const root = resolveExecutionRoot({ projectPath: '/repo/app' })
    expect(root.path).toBe('/repo/app')
    expect(root.projectPath).toBe('/repo/app')
    expect(root.isWorktree).toBe(false)
    expect(root.machineId).toBe(LOCAL_MACHINE_ID)
    expect(root.revision).toBe(0)
    expect(root.branch).toBeNull()
  })

  it('prefers the worktree path and carries its branch', () => {
    const root = resolveExecutionRoot({
      projectPath: '/repo/app',
      worktreePath: '/repo/app/.switchboard/worktrees/feat',
      worktreeBranch: 'sb/feat',
    })
    expect(root.path).toBe('/repo/app/.switchboard/worktrees/feat')
    expect(root.projectPath).toBe('/repo/app')
    expect(root.isWorktree).toBe(true)
    expect(root.branch).toBe('sb/feat')
  })

  it('treats null, undefined and blank worktree pointers as absent', () => {
    for (const worktreePath of [null, undefined, '', '   ']) {
      expect(resolveExecutionRoot({ projectPath: '/repo/app', worktreePath }).path).toBe('/repo/app')
      expect(resolveExecutionRoot({ projectPath: '/repo/app', worktreePath }).isWorktree).toBe(false)
    }
  })

  it('is not a worktree when the pointer equals the project path', () => {
    const root = resolveExecutionRoot({ projectPath: '/repo/app', worktreePath: '/repo/app/' })
    expect(root.isWorktree).toBe(false)
    expect(root.path).toBe('/repo/app')
  })

  it('carries the owning machine and the revision through', () => {
    const root = resolveExecutionRoot({
      projectPath: '/srv/app',
      machineId: 'vm-7',
      executionRootRevision: 4,
    })
    expect(root.machineId).toBe('vm-7')
    expect(root.revision).toBe(4)
  })

  it('normalises a negative or non-integer revision to zero', () => {
    expect(resolveExecutionRoot({ projectPath: '/a', executionRootRevision: -3 }).revision).toBe(0)
    expect(resolveExecutionRoot({ projectPath: '/a', executionRootRevision: 1.5 }).revision).toBe(0)
    expect(resolveExecutionRoot({ projectPath: '/a', executionRootRevision: Number.NaN }).revision).toBe(0)
  })

  it('preserves spaces and quotes in a path', () => {
    const odd = "/repo/my app/it's here"
    expect(resolveExecutionRoot({ projectPath: odd }).path).toBe(odd)
  })
})

describe('normalizeRootPath', () => {
  it('strips one or more trailing separators', () => {
    expect(normalizeRootPath('/repo/app/')).toBe('/repo/app')
    expect(normalizeRootPath('/repo/app///')).toBe('/repo/app')
  })

  it('keeps a bare posix root intact', () => {
    expect(normalizeRootPath('/')).toBe('/')
  })

  it('keeps a windows drive root intact', () => {
    expect(normalizeRootPath('C:\\')).toBe('C:\\')
    expect(normalizeRootPath('C:\\repo\\app\\')).toBe('C:\\repo\\app')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRootPath('  /repo/app  ')).toBe('/repo/app')
  })
})

describe('sameExecutionRoot', () => {
  const base = { projectPath: '/repo/app' }

  it('matches equal paths on the same machine ignoring a trailing slash', () => {
    expect(sameExecutionRoot(
      resolveExecutionRoot(base),
      resolveExecutionRoot({ projectPath: '/repo/app/' }),
    )).toBe(true)
  })

  it('does not match the same path on a different machine', () => {
    expect(sameExecutionRoot(
      resolveExecutionRoot(base),
      resolveExecutionRoot({ ...base, machineId: 'vm-7' }),
    )).toBe(false)
  })

  it('ignores the revision and the branch', () => {
    expect(sameExecutionRoot(
      resolveExecutionRoot({ ...base, executionRootRevision: 1, worktreeBranch: 'main' }),
      resolveExecutionRoot({ ...base, executionRootRevision: 9 }),
    )).toBe(true)
  })
})

describe('isPathWithinRoot', () => {
  it('accepts a descendant and the root itself', () => {
    expect(isPathWithinRoot('/repo/app', '/repo/app/packages/web')).toBe(true)
    expect(isPathWithinRoot('/repo/app', '/repo/app')).toBe(true)
  })

  it('rejects a sibling that merely shares a string prefix', () => {
    expect(isPathWithinRoot('/repo/app', '/repo/app-old/src')).toBe(false)
    expect(isPathWithinRoot('/repo/app', '/repo/application')).toBe(false)
  })

  it('rejects an ancestor and an unrelated path', () => {
    expect(isPathWithinRoot('/repo/app', '/repo')).toBe(false)
    expect(isPathWithinRoot('/repo/app', '/other')).toBe(false)
  })

  it('handles windows paths case-insensitively and separator-agnostically', () => {
    expect(isPathWithinRoot('C:\\repo\\app', 'C:\\Repo\\App\\src')).toBe(true)
    expect(isPathWithinRoot('C:\\repo\\app', 'C:/repo/app/src')).toBe(true)
    expect(isPathWithinRoot('C:\\repo\\app', 'C:\\repo\\app-old')).toBe(false)
  })

  it('stays case-sensitive for posix paths', () => {
    expect(isPathWithinRoot('/repo/app', '/repo/App/src')).toBe(false)
  })
})

describe('rebaseWithinRoot', () => {
  it('maps a subdirectory across roots', () => {
    expect(rebaseWithinRoot('/old/wt', '/new/wt', '/old/wt/packages/app'))
      .toEqual({ path: '/new/wt/packages/app', relative: 'packages/app' })
  })

  it('maps the root itself to the new root with no relative segment', () => {
    expect(rebaseWithinRoot('/old/wt', '/new/wt', '/old/wt'))
      .toEqual({ path: '/new/wt', relative: '' })
  })

  it('returns null when the path is outside the old root', () => {
    expect(rebaseWithinRoot('/old/wt', '/new/wt', '/elsewhere/src')).toBeNull()
  })

  it('returns null for a sibling that shares a string prefix', () => {
    expect(rebaseWithinRoot('/old/wt', '/new/wt', '/old/wt-backup/src')).toBeNull()
  })

  it('keeps the separator style of the target root', () => {
    expect(rebaseWithinRoot('C:\\old\\wt', 'C:\\new\\wt', 'C:\\old\\wt\\src'))
      .toEqual({ path: 'C:\\new\\wt\\src', relative: 'src' })
  })

  it('preserves spaces in the relative segment', () => {
    expect(rebaseWithinRoot('/old/wt', '/new/wt', '/old/wt/my app'))
      .toEqual({ path: '/new/wt/my app', relative: 'my app' })
  })
})

describe('describeExecutionRoot', () => {
  it('names the parent checkout when no worktree is active', () => {
    expect(describeExecutionRoot(resolveExecutionRoot({ projectPath: '/repo/app' })))
      .toBe('app')
  })

  it('names the worktree branch when one is active', () => {
    expect(describeExecutionRoot(resolveExecutionRoot({
      projectPath: '/repo/app',
      worktreePath: '/repo/app/.switchboard/worktrees/feat',
      worktreeBranch: 'sb/feat',
    }))).toBe('app · sb/feat')
  })
})

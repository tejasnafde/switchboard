import { describe, expect, it } from 'vitest'
import {
  INITIAL_GIT_CONTEXT,
  gitContextAnswered,
  gitContextFailed,
  gitContextLoading,
  presentGitContext,
} from '../../apps/mobile/src/lib/git-context'
import { archiveFailure, canArchive } from '../../apps/mobile/src/lib/thread-archive'

const project = '/repo'
const worktree = '/repo/.switchboard/worktrees/fix-1'

describe('phone git context', () => {
  it('says it is checking before the first answer', () => {
    const view = presentGitContext(project, null, gitContextLoading(INITIAL_GIT_CONTEXT))
    expect(view).toEqual({
      branchLabel: 'Checking branch',
      checkoutLabel: 'Project checkout',
      checkoutPath: project,
      parentProjectPath: null,
      loading: true,
      error: null,
    })
  })

  it('names the branch and the worktree with its parent project', () => {
    const state = gitContextAnswered(gitContextLoading(INITIAL_GIT_CONTEXT), { ok: true, branch: 'fix/totals' })
    expect(presentGitContext(project, worktree, state)).toMatchObject({
      branchLabel: 'fix/totals',
      checkoutLabel: 'Worktree',
      checkoutPath: worktree,
      parentProjectPath: project,
      loading: false,
    })
  })

  it('reads a null branch as a detached HEAD', () => {
    const state = gitContextAnswered(INITIAL_GIT_CONTEXT, { ok: true, branch: null })
    expect(presentGitContext(project, '  ', state).branchLabel).toBe('Detached HEAD')
    expect(presentGitContext(project, '  ', state).checkoutLabel).toBe('Project checkout')
  })

  it('keeps the last branch and shows the error when a refresh fails', () => {
    const known = gitContextAnswered(INITIAL_GIT_CONTEXT, { ok: true, branch: 'main' })
    const failed = gitContextAnswered(gitContextLoading(known), {
      ok: false,
      error: 'fatal: not a git repository',
    })
    expect(presentGitContext(project, null, failed)).toMatchObject({
      branchLabel: 'main',
      loading: false,
      error: 'fatal: not a git repository',
    })
  })

  it('shows branch unavailable for a missing folder or a lost connection', () => {
    const missing = gitContextAnswered(INITIAL_GIT_CONTEXT, {
      ok: false,
      error: 'Folder no longer exists: /x',
      missing: true,
    })
    expect(missing.missing).toBe(true)
    expect(presentGitContext(project, null, missing).branchLabel).toBe('Branch unavailable')
    const lost = gitContextFailed(gitContextLoading(INITIAL_GIT_CONTEXT), 'Not in the demo.')
    expect(presentGitContext(project, null, lost)).toMatchObject({
      branchLabel: 'Branch unavailable',
      error: 'Not in the demo.',
    })
  })

  it('clears the error when a refresh starts', () => {
    const failed = gitContextFailed(INITIAL_GIT_CONTEXT, 'timed out')
    expect(gitContextLoading(failed)).toMatchObject({ loading: true, error: null })
  })
})

describe('phone archive', () => {
  it('archives only while no turn runs or starts', () => {
    expect(canArchive('idle', false)).toBe(true)
    expect(canArchive('error', false)).toBe(true)
    expect(canArchive('stopped', false)).toBe(true)
    expect(canArchive('running', false)).toBe(false)
    expect(canArchive('connecting', false)).toBe(false)
    expect(canArchive('idle', true)).toBe(false)
  })

  it('needs the backend to confirm the archive', () => {
    expect(archiveFailure({ ok: true, archived: true })).toBeNull()
    expect(archiveFailure({ ok: true, archived: false })).toBe('Backend did not confirm the archive')
    expect(archiveFailure({ ok: false, error: 'no row' })).toBe('no row')
    expect(archiveFailure(undefined)).toBe('Backend did not confirm the archive')
  })
})

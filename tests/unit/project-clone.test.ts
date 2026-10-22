import { describe, expect, it } from 'vitest'
import {
  chooseCloneRemote,
  cloneFolderName,
  isSafeCloneUrl,
  isTextContent,
  isValidCloneFolderName,
  lastProgressLine,
  offerableIgnoredPath,
} from '../../src/shared/project-clone'
import { isChannelAllowed } from '../../src/shared/device-auth'

describe('chooseCloneRemote', () => {
  it('clones the remote the current branch tracks, so a fork wins over origin', () => {
    expect(
      chooseCloneRemote({
        branch: 'feat/x',
        trackedRemote: 'fork',
        trackedMerge: 'refs/heads/feat/x-remote',
        remotes: ['origin', 'fork'],
      }),
    ).toEqual({ remote: 'fork', remoteBranch: 'feat/x-remote' })
  })

  it('falls back to origin, then the first remote, with the local branch name', () => {
    const untracked = { branch: 'wip', trackedRemote: null, trackedMerge: null }
    expect(chooseCloneRemote({ ...untracked, remotes: ['upstream', 'origin'] })).toEqual({
      remote: 'origin',
      remoteBranch: 'wip',
    })
    expect(chooseCloneRemote({ ...untracked, remotes: ['mine'] })).toEqual({ remote: 'mine', remoteBranch: 'wip' })
  })

  it('ignores a branch that tracks a local branch or a missing remote', () => {
    expect(
      chooseCloneRemote({ branch: 'a', trackedRemote: '.', trackedMerge: 'refs/heads/main', remotes: ['origin'] }),
    ).toEqual({ remote: 'origin', remoteBranch: 'a' })
  })

  it('answers null with no remote, and the default branch on a detached HEAD', () => {
    expect(chooseCloneRemote({ branch: 'main', trackedRemote: null, trackedMerge: null, remotes: [] })).toBeNull()
    expect(chooseCloneRemote({ branch: null, trackedRemote: null, trackedMerge: null, remotes: ['origin'] })).toEqual({
      remote: 'origin',
      remoteBranch: null,
    })
  })
})

describe('ignored file rules', () => {
  it('offers files, never folders or anything under install and build folders', () => {
    expect(offerableIgnoredPath('.env')).toBe(true)
    expect(offerableIgnoredPath('config/.env.local')).toBe(true)
    expect(offerableIgnoredPath('node_modules/')).toBe(false)
    expect(offerableIgnoredPath('tmp/')).toBe(false)
    expect(offerableIgnoredPath('packages/a/node_modules/x.json')).toBe(false)
    expect(offerableIgnoredPath('dist/app.js')).toBe(false)
    expect(offerableIgnoredPath('.venv/pyvenv.cfg')).toBe(false)
    expect(offerableIgnoredPath('')).toBe(false)
  })

  it('takes UTF-8 text only', () => {
    expect(isTextContent(new TextEncoder().encode('KEY=value\n'))).toBe(true)
    expect(isTextContent(new Uint8Array([0x4b, 0x00, 0x41]))).toBe(false)
    expect(isTextContent(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false)
  })
})

describe('clone request checks', () => {
  it('refuses URLs that run commands or read as options', () => {
    expect(isSafeCloneUrl('git@github.com:me/repo.git')).toBe(true)
    expect(isSafeCloneUrl('https://github.com/me/repo.git')).toBe(true)
    expect(isSafeCloneUrl('/srv/git/repo.git')).toBe(true)
    expect(isSafeCloneUrl('ext::sh -c touch% /tmp/pwned')).toBe(false)
    expect(isSafeCloneUrl('fd::3')).toBe(false)
    expect(isSafeCloneUrl('--upload-pack=touch /tmp/x')).toBe(false)
    expect(isSafeCloneUrl('https://x\n')).toBe(false)
  })

  it('makes a safe folder name from the project path', () => {
    expect(cloneFolderName('/Users/me/Desktop/projects/switchboard')).toBe('switchboard')
    expect(cloneFolderName('C:\\work\\My App\\')).toBe('My-App')
    expect(cloneFolderName('/x/..')).toBe('project')
    expect(isValidCloneFolderName('switchboard')).toBe(true)
    expect(isValidCloneFolderName('..')).toBe(false)
    expect(isValidCloneFolderName('a/b')).toBe(false)
  })

  it('reads the last rewritten progress line', () => {
    expect(lastProgressLine('Cloning into x...\nReceiving objects:  10%\rReceiving objects:  55%\r')).toBe(
      'Receiving objects:  55%',
    )
  })

  it('keeps every clone channel away from a phone', () => {
    expect(isChannelAllowed(['chat'], 'project-clone:read-ignored')).toBe(false)
    expect(isChannelAllowed(['chat', 'terminal', 'admin'], 'project-clone:clone')).toBe(true)
  })
})

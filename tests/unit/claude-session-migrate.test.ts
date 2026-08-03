/** Real tmp dirs, no mocks - the logic is filesystem placement. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureClaudeSessionResumable,
  listClaudeSessionCopies,
  findClaudeSessionFile,
  claudeSessionResumableIn,
  claudeSessionResumePath,
  locateResumeTranscript,
  describeResumeFailure,
} from '../../src/main/provider/claude-session-migrate'
import { encodeClaudeProjectPath } from '../../src/main/projects/session-scanner'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const REPO = '/Users/tejas/Desktop/work/example'
/** Worktree of REPO. Its encoded name has REPO's as a prefix - that is the readdir trap. */
const WORKTREE = `${REPO}/.claude/worktrees/feature`
const TMP_WORKTREE = '/private/tmp/wt-admin-broadcast'

describe('transcript placement', () => {
  let root: string
  let profileA: string
  let profileB: string

  /**
   * Write a transcript for `cwd` under `dir`. Every seed is stamped in the
   * past, so a fresh copy (which lands with mtime = now) always outranks a
   * seeded source and idempotency is observable.
   */
  function seed(dir: string, cwd: string, body: string, agoSeconds = 0): string {
    const path = claudeSessionResumePath(dir, SESSION_ID, cwd)
    mkdirSync(join(dir, 'projects', encodeClaudeProjectPath(cwd)), { recursive: true })
    writeFileSync(path, body)
    const when = new Date(Date.now() - (agoSeconds + 60) * 1000)
    utimesSync(path, when, when)
    return path
  }

  const ensure = (toDir: string, cwd: string, candidates: string[]) =>
    ensureClaudeSessionResumable({ sessionId: SESSION_ID, cwd, toDir, candidates })

  const readResume = (dir: string, cwd: string) =>
    readFileSync(claudeSessionResumePath(dir, SESSION_ID, cwd), 'utf-8')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-transcript-'))
    profileA = join(root, 'profile-a')
    profileB = join(root, 'profile-b')
    mkdirSync(profileA, { recursive: true })
    mkdirSync(profileB, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('does nothing when the transcript already sits at the resume path', () => {
    seed(profileA, REPO, 'turns\n')
    expect(ensure(profileA, REPO, [profileA])).toEqual({ ok: true, copied: false })
  })

  it('reports source-missing when no profile holds the transcript', () => {
    expect(ensure(profileA, REPO, [profileA, profileB])).toEqual({
      ok: false,
      reason: 'source-missing',
    })
  })

  it('re-files across profiles (instance switch)', () => {
    const src = seed(profileB, REPO, 'from B\n')
    const result = ensure(profileA, REPO, [profileA, profileB])
    expect(result).toEqual({ ok: true, copied: true, from: src })
    expect(readResume(profileA, REPO)).toBe('from B\n')
  })

  it('re-files within one profile when the cwd moved (live-captured failure)', () => {
    // 2026-08-03: same profile, transcript still filed under the repo, so a
    // fromDir/toDir comparison saw "nothing to do" and resume failed.
    const src = seed(profileA, REPO, 'repo turns\n')
    const result = ensure(profileA, TMP_WORKTREE, [profileA])
    expect(result).toEqual({ ok: true, copied: true, from: src })
    expect(readResume(profileA, TMP_WORKTREE)).toBe('repo turns\n')
  })

  it('leaves every source untouched, so switching back never loses a profile', () => {
    const src = seed(profileB, REPO, 'from B\n')
    ensure(profileA, REPO, [profileA, profileB])
    expect(existsSync(src)).toBe(true)
    expect(readFileSync(src, 'utf-8')).toBe('from B\n')
  })

  it('takes the newest copy, not the first directory listed', () => {
    // Readdir order re-filed a 1-turn transcript over a 21-turn one.
    seed(profileA, REPO, 'one turn\n', 3600)
    seed(profileA, WORKTREE, 'twenty one turns\n', 0)
    const result = ensure(profileA, TMP_WORKTREE, [profileA])
    expect(result.ok).toBe(true)
    expect(readResume(profileA, TMP_WORKTREE)).toBe('twenty one turns\n')
  })

  it('refreshes a stale destination after a round trip between profiles', () => {
    // A -> B -> A. B kept growing, A froze at the first switch.
    seed(profileA, REPO, 'turns 1-5\n', 3600)
    seed(profileB, REPO, 'turns 1-25\n', 0)
    const result = ensure(profileA, REPO, [profileA, profileB])
    expect(result.ok).toBe(true)
    expect(readResume(profileA, REPO)).toBe('turns 1-25\n')
  })

  it('never overwrites a newer destination with an older source', () => {
    seed(profileA, REPO, 'turns 1-25\n', 0)
    seed(profileB, REPO, 'turns 1-5\n', 3600)
    expect(ensure(profileA, REPO, [profileA, profileB])).toEqual({ ok: true, copied: false })
    expect(readResume(profileA, REPO)).toBe('turns 1-25\n')
  })

  it('surfaces a destination IO failure instead of claiming nothing was found', () => {
    seed(profileB, REPO, 'from B\n')
    // A file where the destination's project dir must go, so mkdirSync fails.
    const blocked = join(profileA, 'projects')
    writeFileSync(blocked, 'not a directory')
    const result = ensureClaudeSessionResumable({
      sessionId: SESSION_ID,
      cwd: REPO,
      toDir: profileA,
      candidates: [profileA, profileB],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('io-error')
    expect(result.detail).toBeTruthy()
  })

  it('distinguishes io-error from source-missing, so a transient fault keeps the resume id', () => {
    // The caller drops the resume id on source-missing only. Conflating the two
    // turned an ENOSPC into a permanently fresh session.
    seed(profileB, REPO, 'from B\n')
    writeFileSync(join(profileA, 'projects'), 'not a directory')
    const io = ensure(profileA, REPO, [profileA, profileB])
    const missing = ensure(profileA, REPO, [profileA])
    expect(io.ok === false && io.reason).toBe('io-error')
    expect(missing.ok === false && missing.reason).toBe('source-missing')
  })

  it('is idempotent - a second call is a no-op, not a re-copy', () => {
    seed(profileB, REPO, 'from B\n')
    expect(ensure(profileA, REPO, [profileA, profileB]).ok).toBe(true)
    expect(ensure(profileA, REPO, [profileA, profileB])).toEqual({ ok: true, copied: false })
  })

  it('tolerates a candidate dir that does not exist yet', () => {
    seed(profileA, REPO, 'turns\n')
    const result = ensure(profileA, TMP_WORKTREE, [profileA, join(root, 'never-created')])
    expect(result.ok).toBe(true)
  })
})

describe('lookup helpers', () => {
  let root: string
  let dir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-lookup-'))
    dir = join(root, 'profile')
    const filed = join(dir, 'projects', encodeClaudeProjectPath(REPO))
    mkdirSync(filed, { recursive: true })
    writeFileSync(join(filed, `${SESSION_ID}.jsonl`), '{"type":"user"}\n')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('claudeSessionResumableIn is exact: a moved cwd is NOT resumable', () => {
    expect(claudeSessionResumableIn(dir, SESSION_ID, REPO)).toBe(true)
    expect(claudeSessionResumableIn(dir, SESSION_ID, TMP_WORKTREE)).toBe(false)
  })

  it('findClaudeSessionFile still locates a transcript filed under another cwd', () => {
    expect(findClaudeSessionFile(dir, SESSION_ID, TMP_WORKTREE)).toBe(
      claudeSessionResumePath(dir, SESSION_ID, REPO),
    )
  })

  it('claudeSessionResumePath is the path the SDK reads', () => {
    expect(claudeSessionResumePath(dir, SESSION_ID, REPO)).toBe(
      join(dir, 'projects', encodeClaudeProjectPath(REPO), `${SESSION_ID}.jsonl`),
    )
  })

  it('listClaudeSessionCopies returns nothing for an unknown id', () => {
    expect(listClaudeSessionCopies(dir, '99999999-9999-9999-9999-999999999999')).toEqual([])
  })

  it('listClaudeSessionCopies returns nothing when the profile has no projects dir', () => {
    expect(listClaudeSessionCopies(join(root, 'empty'), SESSION_ID)).toEqual([])
  })
})

/** The old message named the profile in every case, including when it was right. */
describe('locateResumeTranscript', () => {
  let root: string
  let active: string
  let other: string

  function seed(dir: string, cwd: string): string {
    const path = claudeSessionResumePath(dir, SESSION_ID, cwd)
    mkdirSync(join(dir, 'projects', encodeClaudeProjectPath(cwd)), { recursive: true })
    writeFileSync(path, '{"type":"user"}\n')
    return path
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-locate-'))
    active = join(root, 'active')
    other = join(root, 'other')
    mkdirSync(active, { recursive: true })
    mkdirSync(other, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resumable when it sits at the resume path', () => {
    seed(active, REPO)
    const where = locateResumeTranscript({
      sessionId: SESSION_ID,
      cwd: REPO,
      activeDir: active,
      candidateDirs: [active, other],
    })
    expect(where.kind).toBe('resumable')
  })

  it('other-project-dir when the profile is right and the cwd moved', () => {
    const path = seed(active, REPO)
    const where = locateResumeTranscript({
      sessionId: SESSION_ID,
      cwd: TMP_WORKTREE,
      activeDir: active,
      candidateDirs: [active, other],
    })
    expect(where).toEqual({ kind: 'other-project-dir', path })
    // The bug being fixed: this case must not tell the user to switch profile.
    expect(describeResumeFailure(where)).not.toMatch(/profile/i)
  })

  it('other-profile when another candidate holds it, and names which', () => {
    const path = seed(other, REPO)
    const where = locateResumeTranscript({
      sessionId: SESSION_ID,
      cwd: REPO,
      activeDir: active,
      candidateDirs: [active, other],
    })
    expect(where).toEqual({ kind: 'other-profile', dir: other, path })
    expect(describeResumeFailure(where)).toMatch(/different profile/i)
    expect(describeResumeFailure(where)).toContain('other')
  })

  it('unknown when no known dir holds it', () => {
    const where = locateResumeTranscript({
      sessionId: SESSION_ID,
      cwd: REPO,
      activeDir: active,
      candidateDirs: [active, other],
    })
    expect(where).toEqual({ kind: 'unknown' })
  })

  it('tells the user what to do next in every branch', () => {
    const messages = [
      describeResumeFailure({ kind: 'resumable' }),
      describeResumeFailure({ kind: 'other-project-dir', path: '/a/b/c.jsonl' }),
      describeResumeFailure({ kind: 'other-profile', dir: '/a/p', path: '/a/p/c.jsonl' }),
      describeResumeFailure({ kind: 'unknown' }),
    ]
    for (const m of messages) {
      expect(m).toMatch(/send the message again|switch to that profile|add it under/i)
    }
  })
})

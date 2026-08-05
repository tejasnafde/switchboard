/**
 * Fork used to read `~/.claude/projects/<encode(project_path)>/`, which found
 * nothing for 355 of 361 locatable transcripts on a real install: profiles put
 * the file elsewhere, and a worktree cwd puts it in a different project dir.
 * The visible failure was "upToIndex out of range" when forking any message
 * past the handful mirrored into sqlite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { encodeClaudeProjectPath } from '../../src/main/projects/session-scanner'

const ROOT_ID = 'agent_1785310361636'
const SID = '34aab3c4-5083-4cd2-871e-29087ae04093'
const REPO = '/Users/tejas/Desktop/projects/switchboard'
const WORKTREE = `${REPO}/.claude/worktrees/fix-updater-rename`

let root: string
let profileA: string
let profileB: string

vi.mock('../../src/main/db/database', () => ({
  listSessionIdsForThread: (id: string) => (id === ROOT_ID ? [ROOT_ID, SID] : [id]),
  getConversationById: vi.fn(),
  createForkedConversation: vi.fn(),
  bulkSaveMessages: vi.fn(),
  getMessagesForConversation: vi.fn(() => []),
  messageRowsToChatMessages: vi.fn(() => []),
}))

vi.mock('../../src/main/provider/claude-session-migrate', async (orig) => {
  const actual = await orig<typeof import('../../src/main/provider/claude-session-migrate')>()
  return { ...actual, claudeCandidateDirs: () => [profileA, profileB] }
})

function seed(dir: string, cwd: string, sid: string, agoSeconds = 0): string {
  const projectDir = join(dir, 'projects', encodeClaudeProjectPath(cwd))
  mkdirSync(projectDir, { recursive: true })
  const path = join(projectDir, `${sid}.jsonl`)
  writeFileSync(path, '{"type":"user"}\n')
  const when = new Date(Date.now() - (agoSeconds + 60) * 1000)
  utimesSync(path, when, when)
  return path
}

describe('listClaudeFragmentPaths', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-fork-'))
    profileA = join(root, 'profile-a')
    profileB = join(root, 'profile-b')
    mkdirSync(profileA, { recursive: true })
    mkdirSync(profileB, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a fragment in a non-default profile', async () => {
    const { listClaudeFragmentPaths } = await import('../../src/main/conversations/fork')
    const path = seed(profileB, REPO, ROOT_ID)
    expect(listClaudeFragmentPaths(ROOT_ID)).toEqual([path])
  })

  it('finds a fragment filed under a worktree cwd, not project_path', async () => {
    const { listClaudeFragmentPaths } = await import('../../src/main/conversations/fork')
    const path = seed(profileA, WORKTREE, ROOT_ID)
    expect(listClaudeFragmentPaths(ROOT_ID)).toEqual([path])
  })

  it('returns every fragment of the thread in ancestry order', async () => {
    const { listClaudeFragmentPaths } = await import('../../src/main/conversations/fork')
    const rootPath = seed(profileA, REPO, ROOT_ID)
    const childPath = seed(profileB, WORKTREE, SID)
    expect(listClaudeFragmentPaths(ROOT_ID)).toEqual([rootPath, childPath])
  })

  it('takes the newest copy when profiles disagree', async () => {
    const { listClaudeFragmentPaths } = await import('../../src/main/conversations/fork')
    seed(profileA, REPO, ROOT_ID, 3600)
    const fresh = seed(profileB, REPO, ROOT_ID, 0)
    expect(listClaudeFragmentPaths(ROOT_ID)).toEqual([fresh])
  })

  it('skips fragments that are nowhere on disk rather than returning bad paths', async () => {
    const { listClaudeFragmentPaths } = await import('../../src/main/conversations/fork')
    const only = seed(profileA, REPO, SID)
    expect(listClaudeFragmentPaths(ROOT_ID)).toEqual([only])
  })
})

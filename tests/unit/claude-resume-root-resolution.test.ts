/**
 * Regression tests for `resolveClaudeResumeId` resolving a fork/alias thread
 * id to its root before walking `thread_sessions`.
 *
 * Reproduces the v0.8.51 fallback: a chat is reopened keyed by a rotated
 * Claude session UUID (the renderer can hand this back as `opts.threadId`,
 * e.g. after a sidebar reselect of a forked/aliased conversation - see
 * `resolveSessionSelectTarget` in App.tsx). Messages still render because
 * `loadConversationHistory` unions every family id independently. Resume did
 * not: `resolveClaudeResumeId` called `listSessionIdsForThread(threadId)`
 * directly on the raw, unresolved id, which only walks *down* from exactly
 * that id - so a sibling transcript recorded under the true root went
 * missing, and Claude fell back to a cold session even though the transcript
 * was on disk in a known profile.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const ROOT = 'agent_1700000000000' // synthetic root thread id (not a UUID)
const ALIAS = '33333333-3333-4333-8333-333333333333' // rotated Claude session id used as the resume-target thread id
const SIBLING = '44444444-4444-4444-8444-444444444444' // a different rotated session under the same root, transcript survives in another profile

const idToRoot = new Map<string, string>([[ALIAS, ROOT]])
const familyByRoot = new Map<string, string[]>([[ROOT, [ROOT, ALIAS, SIBLING]]])
let typedSegment: { provider_session_id: string } | null = null
const transcriptsByDir = new Map<string, Set<string>>([['/profile-b', new Set([SIBLING])]])

const resolveRootThreadId = vi.fn((id: string) => idToRoot.get(id) ?? id)
const listSessionIdsForThread = vi.fn((id: string) => familyByRoot.get(id) ?? [id])
const resolveResumeSegment = vi.fn(() => typedSegment)
const recordThreadSession = vi.fn()

vi.mock('../../src/main/db/database', () => ({
  resolveRootThreadId: (id: string) => resolveRootThreadId(id),
  listSessionIdsForThread: (id: string) => listSessionIdsForThread(id),
  resolveResumeSegment: (...args: unknown[]) => (resolveResumeSegment as (...a: unknown[]) => unknown)(...args),
  recordThreadSession: (...args: unknown[]) => recordThreadSession(...args),
}))

const claudeCandidateDirs = vi.fn(() => ['/profile-a', '/profile-b'])
const listClaudeSessionCopies = vi.fn((dir: string, id: string) =>
  transcriptsByDir.get(dir)?.has(id) ? [{ id, path: `${dir}/${id}.jsonl` }] : []
)

vi.mock('../../src/main/provider/claude-session-migrate', () => ({
  ensureClaudeSessionResumable: vi.fn(),
  locateResumeTranscript: vi.fn(),
  describeResumeFailure: vi.fn(),
  defaultClaudeDir: vi.fn(() => '/profile-a'),
  claudeCandidateDirs: () => claudeCandidateDirs(),
  listClaudeSessionCopies: (dir: string, id: string) => listClaudeSessionCopies(dir, id),
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/switchboard-vitest' } }))
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn(() => '/usr/local/bin/claude\n'),
}))

const { resolveClaudeResumeId } = await import('../../src/main/provider/adapters/claude-adapter')

beforeEach(() => {
  typedSegment = null
  resolveRootThreadId.mockClear()
  listSessionIdsForThread.mockClear()
  resolveResumeSegment.mockClear()
})

describe('resolveClaudeResumeId resolves fork/alias ids to the root before walking thread_sessions', () => {
  it('finds a sibling transcript recorded under the root when handed a rotated alias id', () => {
    const result = resolveClaudeResumeId(ALIAS)
    expect(result).toBe(SIBLING)
  })

  it('walks thread_sessions from the resolved root, not the raw alias', () => {
    resolveClaudeResumeId(ALIAS)
    expect(listSessionIdsForThread).toHaveBeenCalledWith(ROOT)
    expect(listSessionIdsForThread).not.toHaveBeenCalledWith(ALIAS)
  })

  it('looks up the typed segment against the resolved root, not the raw alias', () => {
    typedSegment = { provider_session_id: SIBLING }
    resolveClaudeResumeId(ALIAS)
    expect(resolveResumeSegment).toHaveBeenCalledWith(ROOT, 'claude-code')
  })

  it('is an unaffected passthrough when the thread id is already the root', () => {
    const result = resolveClaudeResumeId(ROOT)
    expect(result).toBe(SIBLING)
    expect(listSessionIdsForThread).toHaveBeenCalledWith(ROOT)
  })

  it('still returns undefined when no family member has a transcript anywhere', () => {
    transcriptsByDir.clear()
    const result = resolveClaudeResumeId(ALIAS)
    expect(result).toBeUndefined()
    transcriptsByDir.set('/profile-b', new Set([SIBLING]))
  })
})

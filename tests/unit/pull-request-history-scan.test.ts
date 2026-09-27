import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import type { RepoRef, PrRef } from '../../src/shared/pull-requests'
import {
  MAX_HISTORY_SCAN_CHARS,
  scanPendingPullRequestHistory,
  scanPullRequestHistoryForConversation,
  type PullRequestHistoryScanDeps,
  type PullRequestHistoryScanTarget,
} from '../../src/main/pull-requests/history-scan'
import { historyScanSummary } from '../../src/shared/pull-request-links'

vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

const BOT: RepoRef = { host: 'bitbucket', owner: 'geoiq', name: 'ssg-bot-v2' }
const SB: RepoRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard' }
const TARGET: PullRequestHistoryScanTarget = { id: 'agent_1', projectPath: '/repo' }

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: overrides.id ?? 'm1', role: overrides.role ?? 'assistant', content: overrides.content ?? '', timestamp: overrides.timestamp ?? 1, ...overrides }
}

function deps(messages: ChatMessage[], repo: RepoRef | null = BOT): PullRequestHistoryScanDeps {
  const linked: PrRef[] = []
  const notified: string[] = []
  return {
    listUnscanned: vi.fn(() => [TARGET]),
    loadHistory: vi.fn(async () => ({ messages })),
    repoForProject: vi.fn(async () => repo),
    link: vi.fn((_id, ref) => {
      linked.push(ref)
      return true
    }),
    notify: vi.fn((id) => notified.push(id)),
    markScanned: vi.fn(),
    linked,
    notified,
  } as PullRequestHistoryScanDeps & { linked: PrRef[]; notified: string[] }
}

describe('pull request history scan', () => {
  it('links a bbpr-style Bitbucket URL from stored tool output', async () => {
    const d = deps([
      msg({
        content: '',
        toolCalls: [{ id: 'tool_1', name: 'bbpr', input: 'bbpr show 605', output: 'PR: https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/605' }],
      }),
    ]) as PullRequestHistoryScanDeps & { linked: PrRef[]; notified: string[] }

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.link).toHaveBeenCalledWith('agent_1', { ...BOT, number: 605 })
    expect(d.linked).toEqual([{ ...BOT, number: 605 }])
    expect(d.notified).toEqual(['agent_1'])
    expect(result).toMatchObject({ linked: 1, capped: false })
  })

  it('scans user text and ignores a pull request from another repository', async () => {
    const d = deps([
      msg({ role: 'user', content: 'please review https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/605' }),
      msg({ role: 'assistant', content: 'tracked in https://github.com/tejasnafde/switchboard/pull/612' }),
    ], SB) as PullRequestHistoryScanDeps & { linked: PrRef[] }

    await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.linked).toEqual([{ ...SB, number: 612 }])
  })

  it('does not revive an unlinked tombstone', async () => {
    const d = deps([
      msg({ content: 'Closed https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/605 earlier.' }),
    ]) as PullRequestHistoryScanDeps
    vi.mocked(d.link).mockReturnValue(false)

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.link).toHaveBeenCalledOnce()
    expect(d.notify).not.toHaveBeenCalled()
    expect(result.linked).toBe(0)
  })

  it('marks a conversation scanned so the pending scan only loads it once', async () => {
    const scanned = new Set<string>()
    const loadHistory = vi.fn(async () => ({ messages: [msg({ content: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/605' })] }))
    const d: PullRequestHistoryScanDeps = {
      listUnscanned: vi.fn(() => scanned.has(TARGET.id) ? [] : [TARGET]),
      loadHistory,
      repoForProject: vi.fn(async () => BOT),
      link: vi.fn(() => true),
      notify: vi.fn(),
      markScanned: vi.fn((id) => { scanned.add(id) }),
    }

    await scanPendingPullRequestHistory(d, { batchSize: 10, concurrency: 1, yieldMs: 0 })
    await scanPendingPullRequestHistory(d, { batchSize: 10, concurrency: 1, yieldMs: 0 })

    expect(loadHistory).toHaveBeenCalledOnce()
    expect(d.markScanned).toHaveBeenCalledOnce()
  })

  it('caps the scanned text per chat', async () => {
    const d = deps([
      msg({ content: 'a'.repeat(MAX_HISTORY_SCAN_CHARS + 10_000) }),
      msg({ content: 'https://bitbucket.org/geoiq/ssg-bot-v2/pull-requests/605' }),
    ]) as PullRequestHistoryScanDeps

    const result = await scanPullRequestHistoryForConversation(TARGET, d)

    expect(d.link).not.toHaveBeenCalled()
    expect(result.capped).toBe(true)
    expect(result.scannedChars).toBe(MAX_HISTORY_SCAN_CHARS)
  })

  it('works through every batch until no chat is left', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `agent_${i}`, projectPath: '/repo' }))
    const scanned = new Set<string>()
    const d: PullRequestHistoryScanDeps = {
      listUnscanned: vi.fn((limit) => all.filter((t) => !scanned.has(t.id)).slice(0, limit)),
      loadHistory: vi.fn(async () => ({ messages: [] })),
      repoForProject: vi.fn(async () => BOT),
      link: vi.fn(() => true),
      notify: vi.fn(),
      markScanned: vi.fn((id) => { scanned.add(id) }),
    }

    const results = await scanPendingPullRequestHistory(d, { batchSize: 2, concurrency: 2, yieldMs: 0 })

    expect(results.map((r) => r.conversationId).sort()).toEqual(all.map((t) => t.id))
    expect(d.repoForProject).not.toHaveBeenCalled()
  })

  it('stops instead of looping on a chat that cannot be marked', async () => {
    const d: PullRequestHistoryScanDeps = {
      listUnscanned: vi.fn(() => [TARGET]),
      loadHistory: vi.fn(async () => { throw new Error('unreadable') }),
      repoForProject: vi.fn(async () => BOT),
      link: vi.fn(() => true),
      notify: vi.fn(),
      markScanned: vi.fn(),
    }

    await expect(scanPendingPullRequestHistory(d, { yieldMs: 0 })).resolves.toEqual([])
    expect(d.loadHistory).toHaveBeenCalledOnce()
    expect(d.markScanned).toHaveBeenCalledWith(TARGET.id)
  })
})

describe('historyScanSummary', () => {
  it('names the count and says when a long chat was only partly read', () => {
    expect(historyScanSummary({ ok: true, linked: 2, capped: true, capChars: 250_000 })).toEqual({
      title: 'Linked 2 pull requests',
      body: "Only pull requests of this chat's project repository are linked, and one you unlinked stays unlinked. This chat is long, so only its first 250,000 characters were read.",
    })
    expect(historyScanSummary({ ok: true, linked: 0, capped: false, capChars: 250_000 }).title).toBe('No new pull requests found')
    expect(historyScanSummary({ ok: false, message: 'Not a chat.' })).toEqual({ title: 'Could not scan this chat', body: 'Not a chat.' })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ConversationForkWorktreePort } from '../../src/main/conversations/fork-worktree-owner'
import type { ForkSourceGitReceipt, PreparedForkSnapshot } from '../../src/main/conversations/conversation-fork-coordinator'
import type { ForkConversationRequest, ForkConversationResult } from '../../src/shared/conversation-fork'

const HEAD = 'a'.repeat(40)
const STATUS = 'b'.repeat(64)

function prepared(): PreparedForkSnapshot {
  return {
    version: 1,
    conversationId: 'fork-1',
    source: {
      conversationId: 'source', projectPath: '/repo', sourceCheckoutPath: '/source-worktree',
      sourceWorktreePath: '/source-worktree', sourceWorktreeBranch: 'source',
      sourceWorktreeId: 'source-worktree-id', machineId: 'remote-a', agentType: 'codex',
      providerSessionId: 'native', providerInstanceId: 'codex-work', runtimeMode: 'sandbox',
      model: 'gpt-5', reasoningEffort: 'high', launchConfigName: null, title: 'Source',
    },
    prefix: [{ id: 'message-1', role: 'user', content: 'Fix the race', timestamp: 1 }],
    anchor: {
      messageId: 'message-1', role: 'user', timestamp: 1, contentDigest: 'c'.repeat(64),
      canonicalIndex: 0, canonicalMessageCount: 1, resolution: 'exact-id', provider: 'codex',
      providerSessionId: 'native', providerEventId: 'message-1',
    },
  }
}

function request(confirmed = false): ForkConversationRequest {
  return {
    schemaVersion: 1, requestId: 'request-1', sourceConversationId: 'source', machineId: 'remote-a',
    anchor: { messageId: 'message-1', role: 'user', timestamp: 1, contentDigest: 'c'.repeat(64) },
    checkout: {
      kind: 'new-worktree', basePolicy: 'source-head',
      ...(confirmed ? { dirtySourceConfirmed: { headSha: HEAD, statusDigest: STATUS } } : {}),
    },
    provenance: { surface: 'desktop', requestedAt: 10 },
  }
}

const dirty: ForkSourceGitReceipt = {
  canonicalProjectPath: '/repo', sourceCheckoutPath: '/source-worktree', headSha: HEAD,
  statusDigest: STATUS, trackedChanges: 1, untrackedChanges: 1,
  omittedChangeSummary: '1 tracked and 1 untracked change will not be copied.',
}

describe('ConversationForkWorktreePort', () => {
  it('freezes source HEAD and status into the prepared operation before side effects', async () => {
    const inspect = vi.fn(async () => dirty)
    const port = new ConversationForkWorktreePort(
      { createWorktreeTransaction: vi.fn() } as never,
      { getResult: vi.fn() } as never,
      { inspect },
    )

    const frozen = await port.prepare({ request: request(), prepared: prepared() })

    expect(frozen.git).toEqual(dirty)
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('requires an exact dirty-source confirmation before invoking the worktree transaction', async () => {
    const createWorktreeTransaction = vi.fn()
    const port = new ConversationForkWorktreePort(
      { createWorktreeTransaction } as never,
      { getResult: vi.fn() } as never,
      { inspect: vi.fn(async () => dirty) },
    )

    const frozen = { ...prepared(), git: dirty }
    await expect(port.create({ request: request(), prepared: frozen })).resolves.toMatchObject({
      kind: 'confirmation-required',
      dirtySource: { headSha: HEAD, statusDigest: STATUS, trackedChanges: 1, untrackedChanges: 1 },
    })
    expect(createWorktreeTransaction).not.toHaveBeenCalled()
  })

  it('materializes from the frozen source SHA without nesting and returns the durable result', async () => {
    const result = { requestId: 'request-1' } as ForkConversationResult
    const createWorktreeTransaction = vi.fn(async (worktreeRequest) => ({
      status: 'ready', phase: 'ready', worktreePath: '/repo/.switchboard/worktrees/fork',
      branch: 'fork/fix', ...worktreeRequest,
    }))
    const port = new ConversationForkWorktreePort(
      { createWorktreeTransaction } as never,
      { getResult: vi.fn(() => result) } as never,
      { inspect: vi.fn(async () => dirty) },
    )

    await expect(port.create({ request: request(true), prepared: { ...prepared(), git: dirty } }))
      .resolves.toEqual({ kind: 'completed', result })
    expect(createWorktreeTransaction).toHaveBeenCalledWith(expect.objectContaining({
      creationId: 'request-1',
      repository: { projectPath: '/source-worktree', machineId: 'remote-a' },
      checkout: expect.objectContaining({ baseRef: HEAD, location: 'managed-in-repo' }),
      owner: expect.objectContaining({
        kind: 'fork', requestId: 'request-1', conversationId: 'fork-1',
        parentConversationId: 'source', sourceDirty: true,
      }),
      lineage: expect.objectContaining({ parentWorktreeId: 'source-worktree-id', sourceMessageId: 'message-1' }),
    }))
    expect(JSON.stringify(createWorktreeTransaction.mock.calls[0][0])).not.toContain('upToIndex')
  })

  it('rejects a confirmation after HEAD or status changes', async () => {
    const createWorktreeTransaction = vi.fn()
    const port = new ConversationForkWorktreePort(
      { createWorktreeTransaction } as never,
      { getResult: vi.fn() } as never,
      { inspect: vi.fn(async () => ({ ...dirty, headSha: 'd'.repeat(40) })) },
    )
    await expect(port.create({ request: request(true), prepared: { ...prepared(), git: dirty } })).resolves.toMatchObject({
      kind: 'failed', error: { code: 'dirty-source-changed' },
    })
    expect(createWorktreeTransaction).not.toHaveBeenCalled()
  })
})

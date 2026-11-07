import { createMigratedDb } from './helpers/test-db'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeForkMessage, type ForkConversationRequest } from '../../src/shared/conversation-fork'
import type { ChatMessage } from '../../src/shared/types'
import { ConversationForkCoordinator } from '../../src/main/conversations/conversation-fork-coordinator'
import type { CanonicalForkMessage } from '../../src/main/conversations/fork-anchor'
import type { ForkSourceExecution } from '../../src/main/conversations/fork-source'
import { SqliteConversationForkStore } from '../../src/main/db/conversation-fork'
import { closeDb } from '../../src/main/db/database'

afterEach(() => {
  closeDb()
})

/** The app's own migrated schema - see the note in conversation-fork-store.test.ts. */
function database(): Database.Database {
  const db = createMigratedDb()
  db.exec(`
    INSERT INTO projects (path, name) VALUES ('/repo', 'repo');
    INSERT INTO conversations (
      id, project_path, agent_type, session_id, title, created_at, updated_at,
      runtime_mode, model, provider_instance_id, sidebar_role
    ) VALUES (
      'source', '/repo', 'codex', 'native-source', 'Source', 1, 1,
      'accept-edits', 'gpt-5', 'codex-work', 'managed'
    );
  `)
  return db
}

function digest(message: ChatMessage): string {
  return createHash('sha256').update(canonicalizeForkMessage(message)).digest('hex')
}

const user: ChatMessage = { id: 'user-1', role: 'user', content: 'Fix it', timestamp: 10 }
const assistant: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'Done',
  timestamp: 20,
  toolCalls: [{ id: 'tool-1', name: 'Read', input: 'README.md', output: 'text', state: 'done' }],
}

function request(overrides: Partial<ForkConversationRequest> = {}): ForkConversationRequest {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    sourceConversationId: 'source',
    machineId: 'remote-a',
    anchor: {
      messageId: assistant.id,
      role: assistant.role,
      timestamp: assistant.timestamp,
      contentDigest: digest(assistant),
    },
    checkout: { kind: 'shared-checkout' },
    provenance: { surface: 'desktop', requestedAt: 100 },
    ...overrides,
  }
}

const source: ForkSourceExecution = {
  conversationId: 'source',
  projectPath: '/repo',
  sourceCheckoutPath: '/repo',
  sourceWorktreePath: null,
  sourceWorktreeBranch: null,
  sourceWorktreeId: null,
  machineId: 'remote-a',
  agentType: 'codex',
  providerSessionId: 'native-source',
  providerInstanceId: 'codex-work',
  runtimeMode: 'accept-edits',
  model: 'gpt-5',
  reasoningEffort: 'high',
  launchConfigName: 'Development',
  title: 'Source',
}

function history(): CanonicalForkMessage[] {
  return [user, assistant].map((message) => ({
    message,
    forkable: true,
    provenance: {
      provider: 'codex' as const,
      providerSessionId: 'native-source',
      providerEventId: message.id,
    },
  }))
}

function harness(options: { messageId?: string } = {}) {
  const db = database()
  const store = new SqliteConversationForkStore(db)
  const loadSource = vi.fn(async () => ({ source, history: history() }))
  const published: string[] = []
  const compensated: string[] = []
  const coordinator = new ConversationForkCoordinator({
    store,
    loadSource,
    ids: {
      conversation: () => 'fork-1',
      message: (conversationId, index) => options.messageId ?? `${conversationId}:message:${index}`,
    },
    clock: () => 200,
    providerArtifacts: {
      prepare: async () => ({
        resumeMode: 'transcript-handoff',
        sessionId: null,
        pendingHandoffFrom: 'codex',
        warnings: [{ code: 'transcript-handoff', message: 'Codex uses a one-time transcript handoff.' }],
        stage: { id: 'stage-1' },
      }),
      publish: async (stage) => {
        published.push(stage.id)
      },
      compensate: async (stage) => {
        compensated.push(stage.id)
      },
    },
  })
  return { db, store, coordinator, loadSource, published, compensated }
}

describe('ConversationForkCoordinator', () => {
  it('creates one authoritative shared-checkout fork from the exact canonical prefix', async () => {
    const h = harness()
    const outcome = await h.coordinator.createOrGet(request())

    expect(outcome).toMatchObject({
      kind: 'completed',
      result: {
        requestId: 'request-1',
        conversation: {
          id: 'fork-1',
          projectPath: '/repo',
          worktreePath: null,
          worktreeBranch: null,
          machineId: 'remote-a',
          providerInstanceId: 'codex-work',
          runtimeMode: 'accept-edits',
          model: 'gpt-5',
          reasoningEffort: 'high',
          launchConfigName: 'Development',
          parentConversationId: 'source',
          resumeMode: 'transcript-handoff',
          anchor: { messageId: 'assistant-1', canonicalIndex: 1, canonicalMessageCount: 2 },
        },
      },
    })
    if (outcome.kind !== 'completed') throw new Error('expected completed fork')
    expect(outcome.result.messages.map((message) => message.id)).toEqual(['fork-1:message:0', 'fork-1:message:1'])
    expect(outcome.result.messages[1].toolCalls).toEqual(assistant.toolCalls)
    expect(h.published).toEqual(['stage-1'])
  })

  it('returns the durable result after response loss without reloading mutable source history', async () => {
    const h = harness()
    const first = await h.coordinator.createOrGet(request())
    const second = await h.coordinator.createOrGet(
      request({
        provenance: { surface: 'desktop', requestedAt: 999 },
      }),
    )

    expect(second).toEqual(first)
    expect(h.loadSource).toHaveBeenCalledTimes(1)
    expect(h.published).toEqual(['stage-1'])
  })

  it('rejects a changed payload under the same request id', async () => {
    const h = harness()
    await h.coordinator.createOrGet(request())
    const changed = request({ anchor: { ...request().anchor, messageId: 'different' } })

    await expect(h.coordinator.createOrGet(changed)).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'idempotency-conflict', retryable: false },
    })
    expect(h.loadSource).toHaveBeenCalledTimes(1)
  })

  it('reports an anchor conflict before publishing an artifact or inserting a fork', async () => {
    const h = harness()
    const stale = request({ anchor: { ...request().anchor, contentDigest: 'f'.repeat(64) } })

    await expect(h.coordinator.createOrGet(stale)).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'anchor-conflict', retryable: false },
    })
    expect(h.published).toEqual([])
    expect(h.db.prepare("SELECT id FROM conversations WHERE id = 'fork-1'").get()).toBeUndefined()
  })

  it('compensates a published provider artifact when the SQLite fork commit fails', async () => {
    const h = harness({ messageId: 'existing-message' })
    h.db
      .prepare(`
      INSERT INTO messages (id, conversation_id, role, content, timestamp)
      VALUES ('existing-message', 'source', 'user', 'collision', 1)
    `)
      .run()

    await expect(h.coordinator.createOrGet(request())).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'persistence-failed', retryable: true },
    })
    expect(h.published).toEqual(['stage-1'])
    expect(h.compensated).toEqual(['stage-1'])
    expect(h.db.prepare("SELECT id FROM conversations WHERE id = 'fork-1'").get()).toBeUndefined()
    expect(h.store.get('remote-a', 'request-1')).toMatchObject({ status: 'pending', revision: 0 })
  })
})

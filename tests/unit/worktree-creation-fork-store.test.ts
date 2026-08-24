import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  ensureWorktreeCreationSchema,
  SqliteWorktreeCreationStore,
} from '../../src/main/db/worktree-creation'
import {
  ensureConversationForkSchema,
  SqliteConversationForkStore,
} from '../../src/main/db/conversation-fork'
import type { WorktreeCreationRequest } from '../../src/shared/worktree-creation'
import type { ForkConversationRequest, ForkConversationResult } from '../../src/shared/conversation-fork'

const request: WorktreeCreationRequest = {
  schemaVersion: 1,
  creationId: 'fork-creation-1',
  repository: { projectPath: '/repo', machineId: 'local' },
  checkout: {
    baseRef: 'HEAD',
    branch: { namespace: 'fork', seed: 'selected turn' },
    location: 'managed-in-repo',
  },
  owner: {
    kind: 'fork',
    requestId: 'fork-request-1',
    conversationId: 'fork-conversation-1',
    parentConversationId: 'parent-conversation-1',
    sourceDirty: false,
  },
  purpose: 'fork',
  setup: { policy: 'skip' },
  lineage: {
    parentConversationId: 'parent-conversation-1',
    sourceMessageId: 'parent-message-2',
  },
  provenance: { surface: 'desktop', machineId: 'local', requestedAt: 100 },
}

function fixture() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      session_id TEXT,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      parent_conversation_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      pending_handoff_from TEXT,
      worktree_id TEXT,
      worktree_creation_id TEXT,
      runtime_mode TEXT,
      model TEXT,
      provider_instance_id TEXT,
      launch_config_name TEXT,
      sidebar_role TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      images TEXT,
      timestamp INTEGER NOT NULL
      ,display_body TEXT,
      pills_meta TEXT
    );
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      worktree_path TEXT,
      worktree_branch TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  ensureConversationForkSchema(db)
  ensureWorktreeCreationSchema(db)
  const store = new SqliteWorktreeCreationStore(db)
  const reserved = store.reserve({
    machineId: 'local',
    creationId: request.creationId,
    schemaVersion: 1,
    requestJson: JSON.stringify(request),
    payloadHash: 'payload',
    worktreeId: 'worktree-1',
    reservedPath: '/repo/.switchboard/worktrees/fork-1',
    reservedBranch: 'fork/selected-turn',
    requestedBaseRef: 'HEAD',
    resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
    materializationPlanJson: '{}',
    now: 100,
  })
  if (reserved.kind !== 'reserved') throw new Error('fixture reservation failed')
  const materializing = store.transition({
    machineId: 'local', creationId: request.creationId,
    expectedRevision: reserved.record.revision,
    phase: 'materializing', status: 'pending', now: 101,
  })
  if (materializing.kind !== 'updated') throw new Error('fixture transition failed')
  const linking = store.transition({
    machineId: 'local', creationId: request.creationId,
    expectedRevision: materializing.record.revision,
    phase: 'linking', status: 'pending', now: 102,
  })
  if (linking.kind !== 'updated') throw new Error('fixture transition failed')
  const forkRequest: ForkConversationRequest = {
    schemaVersion: 1,
    requestId: 'fork-request-1',
    sourceConversationId: 'parent-conversation-1',
    machineId: 'local',
    anchor: {
      messageId: 'parent-message-2', role: 'assistant', timestamp: 20,
      contentDigest: 'a'.repeat(64),
    },
    checkout: { kind: 'new-worktree', basePolicy: 'source-head' },
    provenance: { surface: 'desktop', requestedAt: 100 },
  }
  new SqliteConversationForkStore(db).reserve({
    machineId: 'local', request: forkRequest, requestJson: JSON.stringify(forkRequest),
    requestHash: 'fork-hash', preparedJson: '{}', preparedHash: 'prepared-hash', now: 100,
  })
  return { db, store, linking: linking.record }
}

function commitInput(expectedRevision: number) {
  const conversation: ForkConversationResult['conversation'] = {
    id: 'fork-conversation-1', projectPath: '/repo',
    worktreePath: '/repo/.switchboard/worktrees/fork-1',
    worktreeBranch: 'fork/selected-turn', worktreeId: 'worktree-1',
    machineId: 'local', agentType: 'claude-code', providerInstanceId: 'claude-work',
    runtimeMode: 'sandbox', model: 'claude-sonnet-5', reasoningEffort: null,
    launchConfigName: null, title: 'Parent chat · fork/selected-turn',
    parentConversationId: 'parent-conversation-1',
    anchor: {
      messageId: 'parent-message-2', role: 'assistant', timestamp: 20,
      contentDigest: 'a'.repeat(64), canonicalIndex: 1, canonicalMessageCount: 2,
      resolution: 'exact-id', provider: 'claude-code', providerSessionId: 'source',
      providerEventId: 'parent-message-2',
    },
    resumeMode: 'native', createdAt: 103,
  }
  const messages = [
    { id: 'fork-conversation-1:0', conversationId: conversation.id, role: 'user', content: 'first', toolCallsJson: null, imagesJson: null, timestamp: 10, displayBody: null, pillsMetaJson: null, attachmentsJson: null },
    { id: 'fork-conversation-1:1', conversationId: conversation.id, role: 'assistant', content: 'second', toolCallsJson: null, imagesJson: null, timestamp: 20, displayBody: null, pillsMetaJson: null, attachmentsJson: null },
  ]
  const result: ForkConversationResult = {
    requestId: 'fork-request-1', conversation,
    messages: messages.map((message) => ({ id: message.id, role: message.role as 'user' | 'assistant', content: message.content, timestamp: message.timestamp })),
    nativeResume: { provider: 'claude', sessionId: conversation.id },
    git: { baseSha: '0123456789abcdef0123456789abcdef01234567', path: conversation.worktreePath!, branch: conversation.worktreeBranch!, sourceDirty: false },
    warnings: [],
  }
  return {
    machineId: 'local',
    creationId: request.creationId,
    expectedRevision,
    worktree: {
      id: 'worktree-1',
      repositoryId: '/repo/.git',
      projectPath: '/repo',
      worktreePath: '/repo/.switchboard/worktrees/fork-1',
      branch: 'fork/selected-turn',
      requestedBaseRef: 'HEAD',
      resolvedBaseCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    fork: {
      machineId: 'local', requestId: 'fork-request-1', expectedRevision: 0,
      conversation, sessionId: conversation.id, pendingHandoffFrom: null,
      messages, result, worktreeCreationId: request.creationId, now: 103,
    },
    now: 103,
  }
}

describe('SqliteWorktreeCreationStore fork owner commit', () => {
  it('atomically commits catalog, canonical parent identity, lineage, and copied messages', () => {
    const h = fixture()
    try {
      const result = h.store.commitForkOwner(commitInput(h.linking.revision))

      expect(result.kind).toBe('committed')
      expect(h.db.prepare('SELECT project_path, worktree_path, worktree_branch, parent_conversation_id, session_id FROM conversations').get()).toEqual({
        project_path: '/repo',
        worktree_path: '/repo/.switchboard/worktrees/fork-1',
        worktree_branch: 'fork/selected-turn',
        parent_conversation_id: 'parent-conversation-1',
        session_id: 'fork-conversation-1',
      })
      expect(h.db.prepare('SELECT id, content FROM messages ORDER BY timestamp').all()).toEqual([
        { id: 'fork-conversation-1:0', content: 'first' },
        { id: 'fork-conversation-1:1', content: 'second' },
      ])
      expect(h.db.prepare('SELECT initial_owner_kind, initial_owner_id FROM managed_worktrees').get()).toEqual({
        initial_owner_kind: 'fork',
        initial_owner_id: 'fork-conversation-1',
      })
      expect(h.store.isForkOwnerCommitted({ machineId: 'local', creationId: request.creationId })).toBe(true)
    } finally {
      h.db.close()
    }
  })

  it('rolls back every projection when a copied-message insert fails', () => {
    const h = fixture()
    try {
      h.db.prepare('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
        .run('fork-conversation-1:1', 'other', 'user', 'collision', 1)

      expect(() => h.store.commitForkOwner(commitInput(h.linking.revision))).toThrow()
      expect(h.db.prepare('SELECT count(*) AS count FROM conversations').get()).toEqual({ count: 0 })
      expect(h.db.prepare('SELECT count(*) AS count FROM managed_worktrees').get()).toEqual({ count: 0 })
      expect(h.store.get({ machineId: 'local', creationId: request.creationId })).toMatchObject({
        phase: 'linking',
        revision: h.linking.revision,
        worktreeId: 'worktree-1',
      })
    } finally {
      h.db.close()
    }
  })
})

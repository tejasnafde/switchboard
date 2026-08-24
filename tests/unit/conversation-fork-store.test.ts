import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeForkConversationIdentity,
  canonicalizeForkConversationRequest,
  type ForkConversationRequest,
  type ForkConversationResult,
} from '../../src/shared/conversation-fork'
import { cloneForkMessages, decodeForkMessageRow, type ForkMessageRow } from '../../src/main/conversations/fork-message-codec'
import {
  ensureConversationForkSchema,
  SqliteConversationForkStore,
} from '../../src/main/db/conversation-fork'

const databases: Database.Database[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close()
})

function database(): Database.Database {
  const db = new Database(':memory:')
  databases.push(db)
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
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
      worktree_id TEXT,
      runtime_mode TEXT,
      model TEXT,
      provider_instance_id TEXT,
      pending_handoff_from TEXT,
      launch_config_name TEXT,
      sidebar_role TEXT,
      FOREIGN KEY (project_path) REFERENCES projects(path) ON DELETE CASCADE
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls TEXT,
      images TEXT,
      timestamp INTEGER NOT NULL,
      display_body TEXT,
      pills_meta TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    INSERT INTO projects (path, name) VALUES ('/repo', 'repo');
    INSERT INTO conversations (
      id, project_path, agent_type, session_id, title, created_at, updated_at,
      runtime_mode, model, provider_instance_id, sidebar_role
    ) VALUES (
      'source', '/repo', 'codex', 'codex-native', 'Source', 1, 1,
      'sandbox', 'gpt-5', 'codex-work', 'managed'
    );
  `)
  ensureConversationForkSchema(db)
  return db
}

function request(): ForkConversationRequest {
  return {
    schemaVersion: 1,
    requestId: 'fork-request-1',
    sourceConversationId: 'source',
    machineId: 'machine-remote',
    anchor: {
      messageId: 'source-message',
      role: 'assistant',
      timestamp: 20,
      contentDigest: 'a'.repeat(64),
    },
    checkout: { kind: 'new-worktree', basePolicy: 'source-head' },
    provenance: { surface: 'desktop', requestedAt: 100 },
  }
}

function reserve(store: SqliteConversationForkStore, input: ForkConversationRequest = request()) {
  return store.reserve({
    machineId: 'machine-remote',
    request: input,
    requestJson: canonicalizeForkConversationRequest(input),
    requestHash: canonicalizeForkConversationIdentity(input),
    preparedJson: JSON.stringify({
      anchor: input.anchor,
      prefix: [{ id: 'source-message', role: 'assistant', content: 'Done', timestamp: 20 }],
      sourceHead: 'b'.repeat(40),
    }),
    preparedHash: 'c'.repeat(64),
    now: 100,
  })
}

function committedInput(store: SqliteConversationForkStore) {
  const cloned = cloneForkMessages('fork-conversation', [
    {
      id: 'source-image',
      role: 'user',
      content: '',
      timestamp: 10,
      images: [{ url: 'data:image/png;base64,AAAA', name: 'screen.png' }],
      displayBody: '[[pill:file-1]]',
      pillsMeta: { 'file-1': { label: 'README.md', kind: 'file' } },
    },
    {
      id: 'source-tool',
      role: 'assistant',
      content: 'Done',
      timestamp: 20,
      toolCalls: [{ id: 'tool-1', name: 'Read', input: 'README.md', output: 'contents', state: 'done' }],
      todos: { id: 'todo-1', items: [{ text: 'Done', status: 'completed' }] },
    },
  ], (index) => `fork-conversation:message:${index}`)
  const conversation: ForkConversationResult['conversation'] = {
    id: 'fork-conversation',
    projectPath: '/repo',
    worktreePath: '/repo/.switchboard/worktrees/fork-conversation',
    worktreeBranch: 'fork/conversation',
    worktreeId: 'worktree-fork',
    machineId: 'machine-remote',
    agentType: 'codex',
    providerInstanceId: 'codex-work',
    runtimeMode: 'sandbox',
    model: 'gpt-5',
    reasoningEffort: 'high',
    launchConfigName: 'Development',
    title: 'Source · fork',
    parentConversationId: 'source',
    anchor: {
      ...request().anchor,
      canonicalIndex: 1,
      canonicalMessageCount: 2,
      resolution: 'exact-id',
      provider: 'codex',
      providerSessionId: 'codex-native',
      providerEventId: 'source-message',
    },
    resumeMode: 'transcript-handoff',
    createdAt: 200,
  }
  const result: ForkConversationResult = {
    requestId: request().requestId,
    conversation,
    messages: cloned.messages,
    git: {
      baseSha: 'b'.repeat(40),
      path: conversation.worktreePath!,
      branch: conversation.worktreeBranch!,
      sourceDirty: true,
      omittedChangeSummary: '1 tracked and 1 untracked change were not copied.',
    },
    warnings: [{ code: 'transcript-handoff', message: 'Codex starts with a one-time transcript handoff.' }],
  }
  return {
    machineId: 'machine-remote',
    requestId: request().requestId,
    expectedRevision: 0,
    conversation,
    sessionId: null,
    pendingHandoffFrom: 'codex',
    messages: cloned.rows,
    result,
    worktreeCreationId: 'worktree-create-1',
    now: 200,
    store,
  }
}

describe('conversation fork SQLite store', () => {
  it('installs an additive durable journal and fork metadata', () => {
    const db = database()
    const operationColumns = db.prepare("PRAGMA table_info(conversation_fork_operations)").all() as Array<{ name: string }>
    const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>
    const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>

    expect(operationColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'machine_id', 'request_id', 'request_hash', 'prepared_json', 'prepared_hash',
      'status', 'revision', 'result_json', 'result_conversation_id',
    ]))
    expect(conversationColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'fork_anchor_digest', 'fork_anchor_role', 'fork_anchor_timestamp',
      'fork_anchor_canonical_count', 'fork_resume_mode', 'reasoning_effort',
    ]))
    expect(messageColumns.map((column) => column.name)).toContain('attachments_json')
  })

  it('reserves and freezes one canonical prepared snapshot before side effects', () => {
    const store = new SqliteConversationForkStore(database())
    expect(reserve(store)).toMatchObject({
      kind: 'reserved',
      record: {
        machineId: 'machine-remote',
        requestId: 'fork-request-1',
        sourceConversationId: 'source',
        status: 'pending',
        revision: 0,
        preparedHash: 'c'.repeat(64),
      },
    })
    expect(JSON.parse(store.get('machine-remote', 'fork-request-1')!.preparedJson))
      .toMatchObject({ sourceHead: 'b'.repeat(40), prefix: [{ id: 'source-message' }] })
  })

  it('returns the existing operation for the same request and rejects a changed payload', () => {
    const store = new SqliteConversationForkStore(database())
    expect(reserve(store).kind).toBe('reserved')
    expect(reserve(store)).toMatchObject({ kind: 'duplicate', record: { revision: 0 } })

    const changed = { ...request(), anchor: { ...request().anchor, messageId: 'another-message' } }
    expect(reserve(store, changed)).toMatchObject({ kind: 'conflict', record: { requestId: 'fork-request-1' } })
  })

  it('atomically preserves the parent project identity, worktree projection, settings, lineage, messages and result', () => {
    const db = database()
    const store = new SqliteConversationForkStore(db)
    reserve(store)

    expect(store.commitCompleted(committedInput(store))).toMatchObject({
      kind: 'committed',
      record: { status: 'completed', revision: 1, resultConversationId: 'fork-conversation' },
    })

    expect(db.prepare(`
      SELECT project_path, worktree_path, worktree_branch, parent_conversation_id,
             provider_instance_id, runtime_mode, model, reasoning_effort,
             fork_anchor_digest, fork_resume_mode, pending_handoff_from
        FROM conversations WHERE id = 'fork-conversation'
    `).get()).toEqual({
      project_path: '/repo',
      worktree_path: '/repo/.switchboard/worktrees/fork-conversation',
      worktree_branch: 'fork/conversation',
      parent_conversation_id: 'source',
      provider_instance_id: 'codex-work',
      runtime_mode: 'sandbox',
      model: 'gpt-5',
      reasoning_effort: 'high',
      fork_anchor_digest: 'a'.repeat(64),
      fork_resume_mode: 'transcript-handoff',
      pending_handoff_from: 'codex',
    })

    const rows = db.prepare(`
      SELECT id, conversation_id AS conversationId, role, content,
             tool_calls AS toolCallsJson, images AS imagesJson, timestamp,
             display_body AS displayBody, pills_meta AS pillsMetaJson,
             attachments_json AS attachmentsJson
        FROM messages WHERE conversation_id = 'fork-conversation'
       ORDER BY rowid
    `).all() as ForkMessageRow[]
    const result = store.getResult('machine-remote', 'fork-request-1')
    expect(rows.map(decodeForkMessageRow)).toEqual(result?.messages)
    expect(rows.map((row) => row.id)).toEqual(result?.messages.map((message) => message.id))
    expect(result).toEqual(committedInput(store).result)
  })

  it('returns the same authoritative result after store recreation', () => {
    const db = database()
    const first = new SqliteConversationForkStore(db)
    reserve(first)
    const input = committedInput(first)
    first.commitCompleted(input)

    const restarted = new SqliteConversationForkStore(db)
    expect(restarted.getResult('machine-remote', 'fork-request-1')).toEqual(input.result)
    expect(reserve(restarted)).toMatchObject({ kind: 'duplicate', record: { status: 'completed' } })
  })

  it('rolls back the entire fork commit when one message insert fails', () => {
    const db = database()
    const store = new SqliteConversationForkStore(db)
    reserve(store)
    const input = committedInput(store)
    db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, timestamp)
      VALUES (?, 'source', 'assistant', 'conflict', 1)
    `).run(input.messages[1].id)

    expect(() => store.commitCompleted(input)).toThrow()
    expect(db.prepare("SELECT id FROM conversations WHERE id = 'fork-conversation'").get()).toBeUndefined()
    expect(store.get('machine-remote', 'fork-request-1')).toMatchObject({
      status: 'pending',
      revision: 0,
      resultConversationId: null,
      resultJson: null,
    })
  })

  it('keeps foreign keys enabled and does not require the worktree path to be a project', () => {
    const db = database()
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    const store = new SqliteConversationForkStore(db)
    reserve(store)

    expect(() => store.commitCompleted(committedInput(store))).not.toThrow()
    expect(db.prepare("SELECT path FROM projects WHERE path LIKE '%worktrees%'").all()).toEqual([])
  })
})

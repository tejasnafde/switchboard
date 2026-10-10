import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalizeForkMessage, type ForkConversationRequest } from '../../src/shared/conversation-fork'
import type { AgentProvider, ChatMessage } from '../../src/shared/types'
import { ConversationForkCoordinator } from '../../src/main/conversations/conversation-fork-coordinator'
import { DefaultProviderForkArtifacts } from '../../src/main/conversations/fork-provider-artifacts'
import type { NativeForkRunners } from '../../src/main/conversations/native-fork-runners'
import type { ForkSourceExecution } from '../../src/main/conversations/fork-source'
import { ensureConversationForkSchema, SqliteConversationForkStore } from '../../src/main/db/conversation-fork'

const cleanup: Array<() => void> = []
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})

function database(agentType: AgentProvider): Database.Database {
  const db = new Database(':memory:')
  cleanup.push(() => db.close())
  db.exec(`
    CREATE TABLE projects (path TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent_type TEXT NOT NULL,
      session_id TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, parent_conversation_id TEXT,
      forked_at_message_id TEXT, worktree_path TEXT, worktree_branch TEXT,
      worktree_id TEXT, runtime_mode TEXT, model TEXT, provider_instance_id TEXT,
      pending_handoff_from TEXT, launch_config_name TEXT, sidebar_role TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', tool_calls TEXT, images TEXT,
      timestamp INTEGER NOT NULL, display_body TEXT, pills_meta TEXT
    );
    CREATE TABLE thread_sessions (claude_session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, recorded_at INTEGER NOT NULL);
    CREATE TABLE conversation_segments (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL, provider_instance_id TEXT, ordinal INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(conversation_id, provider, provider_session_id)
    );
    INSERT INTO projects VALUES ('/repo', 'repo');
  `)
  db.prepare(`
    INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at, provider_instance_id)
    VALUES ('source', '/repo', ?, 'Source', 1, 1, 'inst')
  `).run(agentType)
  ensureConversationForkSchema(db)
  return db
}

const digest = (message: ChatMessage) => createHash('sha256').update(canonicalizeForkMessage(message)).digest('hex')
const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'one', timestamp: 10 },
  { id: 'a1', role: 'assistant', content: 'first', timestamp: 20 },
  { id: 'u2', role: 'user', content: 'two', timestamp: 30 },
  { id: 'a2', role: 'assistant', content: 'second', timestamp: 40 },
]

const line = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-09-24T10:00:00.000Z', type, payload })
const text = (role: string, id: string, value: string) =>
  line('response_item', {
    type: 'message',
    role,
    id,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }],
  })
const rollout = [
  line('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
  text('user', 'u1', 'one'),
  text('assistant', 'a1', 'first'),
  line('event_msg', { type: 'task_started', turn_id: 'turn-2' }),
  text('user', 'u2', 'two'),
  text('assistant', 'a2', 'second'),
].join('\n')

function request(anchor: ChatMessage, requestId = 'request-1'): ForkConversationRequest {
  return {
    schemaVersion: 1,
    requestId,
    sourceConversationId: 'source',
    anchor: { messageId: anchor.id, role: anchor.role, timestamp: anchor.timestamp, contentDigest: digest(anchor) },
    checkout: { kind: 'shared-checkout' },
    provenance: { surface: 'desktop', requestedAt: 1 },
  }
}

function harness(
  agentType: 'codex' | 'opencode',
  runners: Partial<NativeForkRunners> = {},
  options: { messageId?: string; listSegments?: () => never } = {},
) {
  const db = database(agentType)
  const store = new SqliteConversationForkStore(db)
  const source: ForkSourceExecution = {
    conversationId: 'source',
    projectPath: '/repo',
    sourceCheckoutPath: '/repo',
    sourceWorktreePath: null,
    sourceWorktreeBranch: null,
    sourceWorktreeId: null,
    machineId: 'local',
    agentType,
    providerSessionId: null,
    providerInstanceId: 'inst',
    runtimeMode: 'sandbox',
    model: null,
    reasoningEffort: null,
    launchConfigName: null,
    title: 'Source',
  }
  const native: NativeForkRunners = {
    readCodexRollout: vi.fn(async () => rollout),
    forkCodexThread: vi.fn(async () => ({ threadId: 'forked-thread', path: null })),
    forkOpencodeSession: vi.fn(async () => 'ses_forked'),
    ...runners,
  }
  const coordinator = new ConversationForkCoordinator({
    store,
    loadSource: async () => ({
      source,
      history: messages.map((message) => ({
        message,
        forkable: true,
        ...(agentType === 'codex'
          ? {
              provenance: {
                provider: 'codex' as const,
                providerSessionId: 'source-thread',
                providerEventId: message.id,
              },
            }
          : {}),
      })),
    }),
    ids: {
      conversation: () => 'fork-1',
      message: (conversationId, index) => options.messageId ?? `${conversationId}:message:${index}`,
    },
    clock: () => 5_000,
    providerArtifacts: new DefaultProviderForkArtifacts({
      resolveInstance: () => ({ id: 'inst', agentType, oauthDir: null, enabled: true }),
      listCompatibleSessionIds: () => [],
      listSegments:
        options.listSegments ??
        (() => [
          { provider: 'opencode', provider_session_id: 'ses_source', provider_instance_id: 'inst', created_at: 5 },
        ]),
      native,
    }),
  })
  return { db, store, coordinator, native }
}

describe('native Codex fork', () => {
  it('forks at the anchor turn and records the new thread for resume', async () => {
    const h = harness('codex')
    const outcome = await h.coordinator.createOrGet(request(messages[1]))

    expect(h.native.forkCodexThread).toHaveBeenCalledWith('inst', {
      threadId: 'source-thread',
      lastTurnId: 'turn-1',
      cwd: '/repo',
    })
    expect(outcome).toMatchObject({
      kind: 'completed',
      result: {
        conversation: { resumeMode: 'native' },
        nativeResume: { provider: 'codex', sessionId: 'forked-thread', copiedMessageCount: 2 },
        warnings: [],
      },
    })
    expect(
      h.db
        .prepare("SELECT session_id, pending_handoff_from, fork_resume_mode FROM conversations WHERE id = 'fork-1'")
        .get(),
    ).toEqual({ session_id: 'forked-thread', pending_handoff_from: null, fork_resume_mode: 'native' })
    expect(
      h.db
        .prepare(
          'SELECT conversation_id, provider, provider_session_id, provider_instance_id FROM conversation_segments',
        )
        .all(),
    ).toEqual([
      {
        conversation_id: 'fork-1',
        provider: 'codex',
        provider_session_id: 'forked-thread',
        provider_instance_id: 'inst',
      },
    ])
    expect(h.db.prepare('SELECT claude_session_id, thread_id FROM thread_sessions').all()).toEqual([
      { claude_session_id: 'forked-thread', thread_id: 'fork-1' },
    ])
  })

  it('reconciles a response-loss retry without forking the thread twice', async () => {
    const h = harness('codex')
    const first = await h.coordinator.createOrGet(request(messages[1]))
    const retried = await h.coordinator.createOrGet(request(messages[1]))

    expect(retried).toEqual(first)
    expect(h.coordinator.get('local', 'request-1')).toEqual(first)
    expect(h.native.forkCodexThread).toHaveBeenCalledTimes(1)
  })

  it('falls back to the handoff when the CLI has no thread/fork', async () => {
    const h = harness('codex', {
      forkCodexThread: async () => {
        throw Object.assign(new Error('Invalid request: unknown variant `thread/fork`'), { code: -32600 })
      },
    })
    const outcome = await h.coordinator.createOrGet(request(messages[3]))

    expect(outcome).toMatchObject({
      kind: 'completed',
      result: { conversation: { resumeMode: 'transcript-handoff' }, warnings: [{ code: 'native-fork-unsupported' }] },
    })
    expect(h.db.prepare("SELECT pending_handoff_from FROM conversations WHERE id = 'fork-1'").get()).toEqual({
      pending_handoff_from: 'codex',
    })
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM conversation_segments').get()).toEqual({ n: 0 })
  })

  it('falls back to the handoff when the anchor has no turn in the rollout', async () => {
    const h = harness('codex', { readCodexRollout: async () => rollout.replace(/.*task_started.*\n?/g, '') })
    const outcome = await h.coordinator.createOrGet(request(messages[1]))

    expect(outcome).toMatchObject({ kind: 'completed', result: { warnings: [{ code: 'native-turn-missing' }] } })
    expect(h.native.forkCodexThread).not.toHaveBeenCalled()
  })

  it('deletes the forked rollout when the fork cannot be committed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-native-fork-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'rollout-forked.jsonl')
    writeFileSync(path, '{}\n')
    const h = harness(
      'codex',
      { forkCodexThread: async () => ({ threadId: 'forked-thread', path }) },
      { messageId: 'taken' },
    )
    h.db
      .prepare("INSERT INTO messages (id, conversation_id, role, timestamp) VALUES ('taken', 'source', 'user', 1)")
      .run()

    await expect(h.coordinator.createOrGet(request(messages[1]))).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'persistence-failed' },
    })
    expect(existsSync(path)).toBe(false)
  })
})

describe('native OpenCode fork', () => {
  it('forks the whole session when the anchor is the latest reply', async () => {
    const h = harness('opencode')
    const outcome = await h.coordinator.createOrGet(request(messages[3]))

    expect(h.native.forkOpencodeSession).toHaveBeenCalledWith('inst', { sessionId: 'ses_source', cwd: '/repo' })
    expect(outcome).toMatchObject({
      kind: 'completed',
      result: {
        conversation: { resumeMode: 'native' },
        nativeResume: { provider: 'opencode', sessionId: 'ses_forked' },
      },
    })
    expect(h.db.prepare('SELECT provider, provider_session_id FROM conversation_segments').all()).toEqual([
      { provider: 'opencode', provider_session_id: 'ses_forked' },
    ])
  })

  it('falls back to the handoff when the session lookup throws', async () => {
    const h = harness(
      'opencode',
      {},
      {
        listSegments: () => {
          throw new Error('database is locked')
        },
      },
    )
    const outcome = await h.coordinator.createOrGet(request(messages[3]))

    expect(outcome).toMatchObject({ kind: 'completed', result: { conversation: { resumeMode: 'transcript-handoff' } } })
    expect(h.native.forkOpencodeSession).not.toHaveBeenCalled()
  })

  it('keeps the handoff for an earlier anchor', async () => {
    const h = harness('opencode')
    const outcome = await h.coordinator.createOrGet(request(messages[1]))

    expect(outcome).toMatchObject({
      kind: 'completed',
      result: { conversation: { resumeMode: 'transcript-handoff' }, warnings: [{ code: 'native-anchor-not-latest' }] },
    })
    expect(h.native.forkOpencodeSession).not.toHaveBeenCalled()
  })

  it('keeps the handoff when the agent lacks session/fork', async () => {
    const { NativeForkUnsupportedError } = await import('../../src/main/conversations/native-fork')
    const h = harness('opencode', {
      forkOpencodeSession: async () => {
        throw new NativeForkUnsupportedError('no fork')
      },
    })
    const outcome = await h.coordinator.createOrGet(request(messages[3]))

    expect(outcome).toMatchObject({ kind: 'completed', result: { warnings: [{ code: 'native-fork-unsupported' }] } })
  })
  it('keeps the handoff and says why when OpenCode 2.x is refused', async () => {
    const { OpencodeUnsupportedVersionError } = await import('../../src/main/provider/adapters/opencode/version')
    const refusal = new OpencodeUnsupportedVersionError('2.0.19', '/usr/local/bin/opencode')
    const h = harness('opencode', {
      forkOpencodeSession: async () => {
        throw refusal
      },
    })
    const outcome = await h.coordinator.createOrGet(request(messages[3]))

    expect(outcome).toMatchObject({
      kind: 'completed',
      result: {
        warnings: [
          {
            code: 'native-fork-unsupported-version',
            message: `${refusal.message} The fork starts with a transcript handoff.`,
          },
        ],
      },
    })
  })
})

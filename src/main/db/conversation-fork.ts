import type Database from 'better-sqlite3'
import type {
  ForkConversationRequest,
  ForkConversationResult,
  ForkConversationState,
} from '../../shared/conversation-fork'
import type { ForkMessageRow } from '../conversations/fork-message-codec'

export type ConversationForkOperationStatus = 'pending' | 'completed' | 'failed'

export interface ConversationForkOperationRecord {
  machineId: string
  requestId: string
  schemaVersion: number
  requestJson: string
  requestHash: string
  sourceConversationId: string
  status: ConversationForkOperationStatus
  revision: number
  preparedJson: string
  preparedHash: string
  resultConversationId: string | null
  resultJson: string | null
  errorJson: string | null
  worktreeCreationId: string | null
  createdAt: number
  updatedAt: number
}

export interface ReserveConversationForkInput {
  machineId: string
  request: ForkConversationRequest
  requestJson: string
  requestHash: string
  preparedJson: string
  preparedHash: string
  now: number
}

export type ReserveConversationForkResult =
  | { kind: 'reserved'; record: ConversationForkOperationRecord }
  | { kind: 'duplicate'; record: ConversationForkOperationRecord }
  | { kind: 'conflict'; record: ConversationForkOperationRecord }

export interface CommitCompletedConversationForkInput {
  machineId: string
  requestId: string
  expectedRevision: number
  conversation: ForkConversationState
  sessionId: string | null
  pendingHandoffFrom: string | null
  messages: ForkMessageRow[]
  result: ForkConversationResult
  worktreeCreationId: string | null
  now: number
}

export type CommitCompletedConversationForkResult =
  | { kind: 'committed'; record: ConversationForkOperationRecord }
  | { kind: 'stale'; record: ConversationForkOperationRecord }

interface OperationRow {
  machine_id: string
  request_id: string
  schema_version: number
  request_json: string
  request_hash: string
  source_conversation_id: string
  status: ConversationForkOperationStatus
  revision: number
  prepared_json: string
  prepared_hash: string
  result_conversation_id: string | null
  result_json: string | null
  error_json: string | null
  worktree_creation_id: string | null
  created_at: number
  updated_at: number
}

function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function addColumn(
  db: Database.Database,
  table: 'conversations' | 'messages',
  existing: Set<string>,
  definition: string,
): void {
  const name = definition.split(/\s+/, 1)[0]
  if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

export function ensureConversationForkSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_fork_operations (
      machine_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
      revision INTEGER NOT NULL DEFAULT 0,
      prepared_json TEXT NOT NULL,
      prepared_hash TEXT NOT NULL,
      result_conversation_id TEXT,
      result_json TEXT,
      error_json TEXT,
      worktree_creation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (machine_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_fork_operations_source
      ON conversation_fork_operations(source_conversation_id, created_at);
  `)

  const conversationColumns = columns(db, 'conversations')
  addColumn(db, 'conversations', conversationColumns, 'fork_anchor_digest TEXT')
  addColumn(db, 'conversations', conversationColumns, 'fork_anchor_role TEXT')
  addColumn(db, 'conversations', conversationColumns, 'fork_anchor_timestamp INTEGER')
  addColumn(db, 'conversations', conversationColumns, 'fork_anchor_canonical_count INTEGER')
  addColumn(db, 'conversations', conversationColumns, 'fork_resume_mode TEXT')
  addColumn(db, 'conversations', conversationColumns, 'reasoning_effort TEXT')
  addColumn(db, 'conversations', conversationColumns, 'worktree_creation_id TEXT')

  const messageColumns = columns(db, 'messages')
  addColumn(db, 'messages', messageColumns, 'attachments_json TEXT')
}

function operationRecord(row: OperationRow): ConversationForkOperationRecord {
  return {
    machineId: row.machine_id,
    requestId: row.request_id,
    schemaVersion: row.schema_version,
    requestJson: row.request_json,
    requestHash: row.request_hash,
    sourceConversationId: row.source_conversation_id,
    status: row.status,
    revision: row.revision,
    preparedJson: row.prepared_json,
    preparedHash: row.prepared_hash,
    resultConversationId: row.result_conversation_id,
    resultJson: row.result_json,
    errorJson: row.error_json,
    worktreeCreationId: row.worktree_creation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class SqliteConversationForkStore {
  constructor(private readonly db: Database.Database) {}

  get(machineId: string, requestId: string): ConversationForkOperationRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM conversation_fork_operations
       WHERE machine_id = ? AND request_id = ?
    `).get(machineId, requestId) as OperationRow | undefined
    return row ? operationRecord(row) : null
  }

  getResult(machineId: string, requestId: string): ForkConversationResult | null {
    const record = this.get(machineId, requestId)
    return record?.status === 'completed' && record.resultJson
      ? JSON.parse(record.resultJson) as ForkConversationResult
      : null
  }

  reserve(input: ReserveConversationForkInput): ReserveConversationForkResult {
    const existing = this.get(input.machineId, input.request.requestId)
    if (existing) {
      return existing.requestHash === input.requestHash
        ? { kind: 'duplicate', record: existing }
        : { kind: 'conflict', record: existing }
    }

    this.db.prepare(`
      INSERT INTO conversation_fork_operations (
        machine_id, request_id, schema_version, request_json, request_hash,
        source_conversation_id, status, revision, prepared_json, prepared_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(
      input.machineId,
      input.request.requestId,
      input.request.schemaVersion,
      input.requestJson,
      input.requestHash,
      input.request.sourceConversationId,
      input.preparedJson,
      input.preparedHash,
      input.now,
      input.now,
    )
    const record = this.get(input.machineId, input.request.requestId)
    if (!record) throw new Error('Fork operation reservation was not persisted')
    return { kind: 'reserved', record }
  }

  commitCompleted(input: CommitCompletedConversationForkInput): CommitCompletedConversationForkResult {
    this.assertCommitMatchesResult(input)

    const commit = this.db.transaction(() => {
      const operation = this.get(input.machineId, input.requestId)
      if (!operation) throw new Error(`Fork operation not found: ${input.requestId}`)
      if (operation.status !== 'pending' || operation.revision !== input.expectedRevision) {
        return { kind: 'stale' as const, record: operation }
      }

      const conversation = input.conversation
      this.db.prepare(`
        INSERT INTO conversations (
          id, project_path, agent_type, session_id, title, created_at, updated_at,
          parent_conversation_id, forked_at_message_id, worktree_path,
          worktree_branch, worktree_id, worktree_creation_id, runtime_mode, model,
          reasoning_effort, provider_instance_id, pending_handoff_from,
          launch_config_name, sidebar_role, fork_anchor_digest, fork_anchor_role,
          fork_anchor_timestamp, fork_anchor_canonical_count, fork_resume_mode
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed',
          ?, ?, ?, ?, ?
        )
      `).run(
        conversation.id,
        conversation.projectPath,
        conversation.agentType,
        input.sessionId,
        conversation.title,
        conversation.createdAt,
        conversation.createdAt,
        conversation.parentConversationId,
        conversation.anchor.messageId,
        conversation.worktreePath,
        conversation.worktreeBranch,
        conversation.worktreeId,
        input.worktreeCreationId,
        conversation.runtimeMode,
        conversation.model,
        conversation.reasoningEffort,
        conversation.providerInstanceId,
        input.pendingHandoffFrom,
        conversation.launchConfigName,
        conversation.anchor.contentDigest,
        conversation.anchor.role,
        conversation.anchor.timestamp,
        conversation.anchor.canonicalMessageCount,
        conversation.resumeMode,
      )

      const insertMessage = this.db.prepare(`
        INSERT INTO messages (
          id, conversation_id, role, content, tool_calls, images, timestamp,
          display_body, pills_meta, attachments_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const message of input.messages) {
        insertMessage.run(
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.toolCallsJson,
          message.imagesJson,
          message.timestamp,
          message.displayBody,
          message.pillsMetaJson,
          message.attachmentsJson,
        )
      }

      const resultJson = JSON.stringify(input.result)
      const update = this.db.prepare(`
        UPDATE conversation_fork_operations
           SET status = 'completed', revision = revision + 1,
               result_conversation_id = ?, result_json = ?, error_json = NULL,
               worktree_creation_id = ?, updated_at = ?
         WHERE machine_id = ? AND request_id = ?
           AND status = 'pending' AND revision = ?
      `).run(
        conversation.id,
        resultJson,
        input.worktreeCreationId,
        input.now,
        input.machineId,
        input.requestId,
        input.expectedRevision,
      )
      if (update.changes !== 1) throw new Error('Fork operation changed during commit')

      const record = this.get(input.machineId, input.requestId)
      if (!record) throw new Error('Completed fork operation disappeared')
      return { kind: 'committed' as const, record }
    })

    return commit()
  }

  private assertCommitMatchesResult(input: CommitCompletedConversationForkInput): void {
    if (input.result.requestId !== input.requestId) {
      throw new Error('Fork result request id does not match the operation')
    }
    if (input.result.conversation.id !== input.conversation.id) {
      throw new Error('Fork result conversation does not match the persisted conversation')
    }
    const persistedIds = input.messages.map((message) => message.id)
    const returnedIds = input.result.messages.map((message) => message.id)
    if (JSON.stringify(persistedIds) !== JSON.stringify(returnedIds)) {
      throw new Error('Fork result messages do not match persisted message ids')
    }
    if (input.messages.some((message) => message.conversationId !== input.conversation.id)) {
      throw new Error('Fork message belongs to a different conversation')
    }
  }
}

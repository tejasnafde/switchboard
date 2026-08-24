import type { ChatMessage } from '../../shared/types'

export interface ForkMessageRow {
  id: string
  conversationId: string
  role: string
  content: string
  toolCallsJson: string | null
  imagesJson: string | null
  timestamp: number
  displayBody: string | null
  pillsMetaJson: string | null
  attachmentsJson: string | null
}

export interface ForkMessageCopyWarning {
  code: 'unknown-message-field'
  messageId: string
  fields: string[]
}

export interface ClonedForkMessages {
  rows: ForkMessageRow[]
  messages: ChatMessage[]
  warnings: ForkMessageCopyWarning[]
}

const MESSAGE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'role',
  'content',
  'toolCalls',
  'images',
  'timestamp',
  'context',
  'approval',
  'plan',
  'todos',
  'question',
  'fileDiff',
  'denial',
  'turnDurationMs',
  'displayBody',
  'pillsMeta',
])

interface ForkAttachments {
  context?: ChatMessage['context']
  approval?: ChatMessage['approval']
  plan?: ChatMessage['plan']
  todos?: ChatMessage['todos']
  question?: ChatMessage['question']
  fileDiff?: ChatMessage['fileDiff']
  denial?: ChatMessage['denial']
  turnDurationMs?: ChatMessage['turnDurationMs']
  extensions?: Record<string, unknown>
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function parsed<T>(value: string | null): T | undefined {
  if (value === null) return undefined
  return JSON.parse(value) as T
}

function messageRow(
  conversationId: string,
  source: ChatMessage,
  id: string,
): { row: ForkMessageRow; warning?: ForkMessageCopyWarning } {
  const sourceRecord = source as ChatMessage & Record<string, unknown>
  const extensionEntries = Object.entries(sourceRecord)
    .filter(([key, value]) => !MESSAGE_FIELDS.has(key) && value !== undefined)
  const extensions = extensionEntries.length > 0
    ? Object.fromEntries(extensionEntries)
    : undefined
  const attachments: ForkAttachments = {
    ...(source.context === undefined ? {} : { context: source.context }),
    ...(source.approval === undefined ? {} : { approval: source.approval }),
    ...(source.plan === undefined ? {} : { plan: source.plan }),
    ...(source.todos === undefined ? {} : { todos: source.todos }),
    ...(source.question === undefined ? {} : { question: source.question }),
    ...(source.fileDiff === undefined ? {} : { fileDiff: source.fileDiff }),
    ...(source.denial === undefined ? {} : { denial: source.denial }),
    ...(source.turnDurationMs === undefined ? {} : { turnDurationMs: source.turnDurationMs }),
    ...(extensions === undefined ? {} : { extensions }),
  }
  const row: ForkMessageRow = {
    id,
    conversationId,
    role: source.role,
    content: source.content,
    toolCallsJson: json(source.toolCalls),
    imagesJson: json(source.images),
    timestamp: source.timestamp,
    displayBody: source.displayBody ?? null,
    pillsMetaJson: json(source.pillsMeta),
    attachmentsJson: Object.keys(attachments).length > 0 ? JSON.stringify(attachments) : null,
  }
  return {
    row,
    ...(extensions === undefined
      ? {}
      : {
          warning: {
            code: 'unknown-message-field' as const,
            messageId: source.id,
            fields: Object.keys(extensions).sort(),
          },
        }),
  }
}

export function decodeForkMessageRow(row: ForkMessageRow): ChatMessage {
  const attachments = parsed<ForkAttachments>(row.attachmentsJson) ?? {}
  return {
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    ...(row.toolCallsJson === null ? {} : { toolCalls: parsed<ChatMessage['toolCalls']>(row.toolCallsJson) }),
    ...(row.imagesJson === null ? {} : { images: parsed<ChatMessage['images']>(row.imagesJson) }),
    ...(row.displayBody === null ? {} : { displayBody: row.displayBody }),
    ...(row.pillsMetaJson === null ? {} : { pillsMeta: parsed<ChatMessage['pillsMeta']>(row.pillsMetaJson) }),
    ...(attachments.context === undefined ? {} : { context: attachments.context }),
    ...(attachments.approval === undefined ? {} : { approval: attachments.approval }),
    ...(attachments.plan === undefined ? {} : { plan: attachments.plan }),
    ...(attachments.todos === undefined ? {} : { todos: attachments.todos }),
    ...(attachments.question === undefined ? {} : { question: attachments.question }),
    ...(attachments.fileDiff === undefined ? {} : { fileDiff: attachments.fileDiff }),
    ...(attachments.denial === undefined ? {} : { denial: attachments.denial }),
    ...(attachments.turnDurationMs === undefined ? {} : { turnDurationMs: attachments.turnDurationMs }),
    ...(attachments.extensions ?? {}),
  }
}

export function cloneForkMessages(
  conversationId: string,
  source: ChatMessage[],
  createMessageId: (index: number, sourceMessage: ChatMessage) => string,
): ClonedForkMessages {
  const warnings: ForkMessageCopyWarning[] = []
  const seen = new Set<string>()
  const rows = source.map((message, index) => {
    const id = createMessageId(index, message)
    if (seen.has(id)) throw new Error(`Duplicate fork message id: ${id}`)
    seen.add(id)
    const encoded = messageRow(conversationId, message, id)
    if (encoded.warning) warnings.push(encoded.warning)
    return encoded.row
  })
  return {
    rows,
    messages: rows.map(decodeForkMessageRow),
    warnings,
  }
}

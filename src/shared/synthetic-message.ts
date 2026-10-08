/**
 * Provider CLIs write machine-generated text into the transcript with the USER
 * role: Claude Code's background-task notifications, interrupt markers and
 * local-command output, Codex's environment and plugin bootstraps. Rendered
 * as-is they read as a "You" bubble full of raw XML.
 *
 * `splitSyntheticUserText` peels the known generated blocks off the FRONT of a
 * user-role text and returns what is left as the real user text. Only leading
 * blocks count, so a prompt that merely mentions `<task-notification>` stays a
 * normal message. Stored data is never rewritten; every surface splits at
 * render time. The Kotlin port is `SyntheticUserMessage` in apps/android.
 */

export type SyntheticUserPart =
  | {
      kind: 'task-notification'
      /** Anything other than completed/failed/stopped is passed through for display. */
      status: string
      summary: string
      taskId?: string
      outputFile?: string
    }
  | { kind: 'interrupted'; duringToolUse: boolean }
  | { kind: 'command-output'; text: string; isError: boolean }
  | { kind: 'compacted'; summary: string }

export interface SyntheticUserSplit {
  /** Parts worth a row. Pure context blocks (env, caveats, reminders) are dropped. */
  parts: SyntheticUserPart[]
  /** What the user actually typed, trimmed. Empty when the whole message was generated. */
  userText: string
}

interface Block {
  start: string
  end: string
  /** Leave `end` in place for the next block (a preamble that introduces one). */
  keepEnd?: boolean
  part?: (inner: string) => SyntheticUserPart | null
  /** Part of a slash-command record, which collapses to the `/name args` the user typed. */
  command?: 'name' | 'args' | 'message'
}

const COMMAND_RECORD_TAGS = ['command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-stderr']

/** A slash-command record is ONLY these tags, so tags pasted ahead of the user's own prose stay their text. */
function isCommandRecord(text: string): boolean {
  let rest = text.trim()
  while (rest) {
    const name = COMMAND_RECORD_TAGS.find((t) => rest.startsWith(`<${t}>`))
    const end = name ? rest.indexOf(`</${name}>`) : -1
    if (!name || end < 0) return false
    rest = rest.slice(end + name.length + 3).trimStart()
  }
  return true
}

function tag(inner: string, name: string): string | undefined {
  const open = `<${name}>`
  const from = inner.indexOf(open)
  if (from < 0) return undefined
  const to = inner.indexOf(`</${name}>`, from)
  if (to < 0) return undefined
  return inner.slice(from + open.length, to).trim() || undefined
}

const COMPACT_SUMMARY_OPEN = '<switchboard-compact-summary>'
const COMPACT_SUMMARY_CLOSE = '</switchboard-compact-summary>'

/** The form a transcript's compact summary takes, so every surface folds it into one row. */
export function compactSummaryText(summary: string): string {
  return `${COMPACT_SUMMARY_OPEN}\n${summary}\n${COMPACT_SUMMARY_CLOSE}`
}

const BLOCKS: readonly Block[] = [
  {
    start: '<task-notification>',
    end: '</task-notification>',
    part: (inner) => ({
      kind: 'task-notification',
      status: tag(inner, 'status') ?? 'completed',
      summary: tag(inner, 'summary') ?? '',
      taskId: tag(inner, 'task-id'),
      outputFile: tag(inner, 'output-file'),
    }),
  },
  {
    start: '[Request interrupted by user',
    end: ']',
    part: (inner) => ({ kind: 'interrupted', duringToolUse: inner.includes('tool use') }),
  },
  { start: '<turn_aborted>', end: '</turn_aborted>', part: () => ({ kind: 'interrupted', duringToolUse: false }) },
  // Claude Code's record of a slash command: `/compact`, `/model x`, a skill
  // with its arguments. The tags come in either order.
  { start: '<command-name>', end: '</command-name>', command: 'name' },
  { start: '<command-message>', end: '</command-message>', command: 'message' },
  { start: '<command-args>', end: '</command-args>', command: 'args' },
  {
    start: '<local-command-stdout>',
    end: '</local-command-stdout>',
    part: (inner) => (inner.trim() ? { kind: 'command-output', text: inner.trim(), isError: false } : null),
  },
  {
    start: '<local-command-stderr>',
    end: '</local-command-stderr>',
    part: (inner) => (inner.trim() ? { kind: 'command-output', text: inner.trim(), isError: true } : null),
  },
  // Some Claude Code setups prefix a task notification with this paragraph.
  { start: '[SYSTEM NOTIFICATION - NOT USER INPUT]', end: '<task-notification>', keepEnd: true },
  { start: '[Your previous response had no visible output', end: ']' },
  { start: '<local-command-caveat>', end: '</local-command-caveat>' },
  { start: '<system-reminder>', end: '</system-reminder>' },
  { start: '<user-prompt-submit-hook>', end: '</user-prompt-submit-hook>' },
  { start: '<recommended_plugins>', end: '</recommended_plugins>' },
  { start: '# AGENTS.md instructions for ', end: '</INSTRUCTIONS>' },
  { start: '<environment_context>', end: '</environment_context>' },
  { start: '<user_instructions>', end: '</user_instructions>' },
  { start: '<external_codex_apps_open_page>', end: '</external_codex_apps_open_page>' },
  { start: '<codex_internal_context', end: '</codex_internal_context>' },
  { start: '<skill>', end: '</skill>' },
  // A Switchboard approval result (shared/agent-approval-cards.ts). The chat
  // shows its own system row for it, so the turn the agent got renders nothing.
  { start: '<switchboard-approval-result>', end: '</switchboard-approval-result>' },
  // A fork's merge-back (shared/merge-back.ts): the parent shows its own
  // delivered row for it, so only what the user typed after it stays a bubble.
  { start: '<switchboard-fork-merge-back>', end: '</switchboard-fork-merge-back>' },
  // A context summary, wrapped by the transcript parser from the record's own
  // `isCompactSummary` flag (`compactSummaryText`), never from its prose.
  {
    start: COMPACT_SUMMARY_OPEN,
    end: COMPACT_SUMMARY_CLOSE,
    part: (inner) => ({ kind: 'compacted', summary: inner.trim() }),
  },
]

/**
 * The transcript form of a task notification, so a live notice goes through
 * the same split as the one rebuilt from the transcript on reload.
 */
export function taskNotificationText(n: { taskId: string; status: string; summary: string; outputFile?: string }): string {
  const lines = [
    `<task-id>${n.taskId}</task-id>`,
    n.outputFile ? `<output-file>${n.outputFile}</output-file>` : '',
    `<status>${n.status}</status>`,
    `<summary>${n.summary}</summary>`,
  ].filter(Boolean)
  return `<task-notification>\n${lines.join('\n')}\n</task-notification>`
}

export const STORED_TASK_NOTICE_PREFIX = 'tasknotice_'

/**
 * The SQLite row a live notice is stored under: one per notice, keyed by the
 * live event's `messageId`, so a replayed event cannot store it twice while a
 * task that reports again (a Monitor emits one notice per event, then one when
 * its stream ends) keeps every notice. Not the live row's own `task_` id,
 * which the desktop reducer skips when it looks for a notice already on screen.
 */
export function storedTaskNoticeId(conversationId: string, messageId: string): string {
  return `${STORED_TASK_NOTICE_PREFIX}${conversationId}:${messageId}`
}

/**
 * How far apart a live notice and its transcript line can be stamped, either
 * way (both on the backend's clock). The CLI writes the line when a turn
 * consumes the notice, measured 20-70ms after it.
 */
export const TRANSCRIPT_NOTICE_SKEW_MS = 5_000

/**
 * True when a transcript row already shows this live notice. The two can
 * share no id: the live event carries the SDK message's uuid, the transcript
 * row its own line's. So identity is the task's fields plus time, which keeps
 * an older identical notice (a resumed subagent finishing again) separate.
 * ponytail: two identical notices for one task inside the skew collapse into
 * one; a notice id in the transcript would be the upgrade.
 */
export function transcriptShowsTaskNotification(
  rows: Iterable<{ part: SyntheticUserPart; at: number }>,
  live: { taskId: string; status: string; summary: string; at: number },
): boolean {
  const key = taskNoticeKey(live)
  for (const { part, at } of rows) {
    if (part.kind === 'task-notification' && taskNoticeKey(part) === key
      && Math.abs(at - live.at) <= TRANSCRIPT_NOTICE_SKEW_MS) return true
  }
  return false
}

/** Equal task id, status and summary, by the transcript parser's rules. */
export function sameTaskNotice(
  a: { taskId?: string; status: string; summary: string },
  b: { taskId?: string; status: string; summary: string },
): boolean {
  return taskNoticeKey(a) === taskNoticeKey(b)
}

/** The transcript parser's rules (`tag` trims, status defaults), applied to either side. */
function taskNoticeKey(n: { taskId?: string; status: string; summary: string }): string {
  return JSON.stringify([n.taskId?.trim() ?? '', n.status.trim() || 'completed', n.summary.trim()])
}

/** Null when `text` does not start with a generated block, i.e. a real user message. */
export function splitSyntheticUserText(text: string): SyntheticUserSplit | null {
  let remaining = text.trim()
  const parts: SyntheticUserPart[] = []
  const command = { name: '', args: '', message: '' }
  let matched = false
  for (;;) {
    const block = BLOCKS.find(({ start }) => remaining.startsWith(start))
    if (!block || (block.command && !isCommandRecord(remaining))) break
    const end = remaining.indexOf(block.end, block.start.length)
    if (end < 0) break
    matched = true
    const inner = remaining.slice(block.start.length, end)
    const part = block.part?.(inner)
    if (part) parts.push(part)
    if (block.command) command[block.command] = inner.trim()
    remaining = remaining.slice(block.keepEnd ? end : end + block.end.length).trimStart()
  }
  if (!matched) return null
  const slash = command.name ? `/${command.name.replace(/^\//, '')}${command.args ? ` ${command.args}` : ''}` : ''
  return { parts, userText: [slash, remaining].filter(Boolean).join('\n') }
}

/**
 * `/name args` for a transcript row that is only a slash-command record (its
 * output included), the text Switchboard stored for that send. Null for
 * anything else.
 */
export function slashCommandRecordText(text: string): string | null {
  if (!isCommandRecord(text)) return null
  const userText = splitSyntheticUserText(text)?.userText
  return userText?.startsWith('/') ? userText : null
}

/** The summary inside `compactSummaryText`, i.e. the row as builds before the wrap stored it. Null for anything else. */
export function unwrapCompactSummaryText(text: string): string | null {
  return text.startsWith(`${COMPACT_SUMMARY_OPEN}\n`) && text.endsWith(`\n${COMPACT_SUMMARY_CLOSE}`)
    ? text.slice(COMPACT_SUMMARY_OPEN.length + 1, -COMPACT_SUMMARY_CLOSE.length - 1)
    : null
}

/** True when nothing in `text` was typed by the user. */
export function isSyntheticOnlyUserText(text: string): boolean {
  return splitSyntheticUserText(text)?.userText === ''
}

/** The user-typed remainder, for titles and previews. */
export function userTypedText(text: string): string {
  return splitSyntheticUserText(text)?.userText ?? text
}

/** One-line label for a compact row, e.g. "Background task failed: Build (exit 144)". */
export function syntheticPartLabel(part: SyntheticUserPart): string {
  switch (part.kind) {
    case 'task-notification': {
      const quoted = /"([^"]+)"/.exec(part.summary)?.[1]
      const exit = /exit code (\d+)/.exec(part.summary)?.[1]
      const what = quoted ?? part.summary
      const exitSuffix = exit && exit !== '0' ? ` (exit ${exit})` : ''
      return `Background task ${part.status}${what ? `: ${what}` : ''}${exitSuffix}`
    }
    case 'interrupted':
      return part.duringToolUse ? 'Interrupted during tool use' : 'Interrupted'
    case 'command-output':
      return part.text
    case 'compacted':
      return 'Conversation compacted'
  }
}

/** Expanded detail for a row: the raw summary plus ids and paths. */
export function syntheticPartDetail(part: SyntheticUserPart): string | undefined {
  if (part.kind === 'compacted') return part.summary || undefined
  if (part.kind !== 'task-notification') return undefined
  const lines = [
    part.summary,
    part.taskId ? `Task: ${part.taskId}` : '',
    part.outputFile ? `Output: ${part.outputFile}` : '',
  ].filter(Boolean)
  return lines.length ? lines.join('\n') : undefined
}

export type SyntheticTone = 'ok' | 'error' | 'warn' | 'muted'

export function syntheticPartTone(part: SyntheticUserPart): SyntheticTone {
  if (part.kind === 'task-notification') {
    if (part.status === 'completed') return 'ok'
    if (part.status === 'failed') return 'error'
    if (part.status === 'stopped') return 'warn'
    return 'muted'
  }
  if (part.kind === 'command-output' && part.isError) return 'error'
  return 'muted'
}

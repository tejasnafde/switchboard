/**
 * `read_child`: a parent reads one of its own children's history through the
 * loader the chat view uses (`loadConversationHistory`), so it works for every
 * provider. A window starts at a pointer (`at`: a tool call id or message id)
 * or an absolute `offset`, else it is the newest messages; `query` searches the
 * whole history. A `report_to_hub` call is returned whole, since its `report`
 * is the child's full report; other tool input and output is clipped. A
 * Codex or ACP child's tool calls come from Switchboard's own copy, which
 * stores at most 32 KiB of a call's input, so a longer report is cut there.
 *
 * Measured: one `hub.read-child` perf line per call (messages returned, total,
 * bytes of the reply, outcome).
 */
import { existsSync } from 'node:fs'
import { isSubagentToolName } from '@shared/subagent-steps'
import type { ChatMessage, ToolCall } from '@shared/types'
import { getHubChild, lastHubWakeOf, resolveRootThreadId } from '../db/database'
import { toolText, type McpToolResult } from '../mcp/mcp-session'
import { perfSpan } from '../perf'
import { createMainLogger } from '../logger'

const log = createMainLogger('hub:read')

export const READ_CHILD_DEFAULT_LIMIT = 20
export const READ_CHILD_MAX_LIMIT = 200
const TOOL_CLIP = 2000
const SUBAGENT_CLIP = 1000

export interface ReadChildArgs {
  childId: string
  at?: string
  offset?: number
  limit?: number
  query?: string
}

/** Agent input, so every field is checked. */
export function parseReadChildArgs(raw: Record<string, unknown>): ReadChildArgs | string {
  if (typeof raw.childId !== 'string' || !raw.childId.trim()) return 'Give childId: the id list_children shows.'
  const args: ReadChildArgs = { childId: raw.childId.trim() }
  if (raw.at !== undefined) {
    if (typeof raw.at !== 'string' || !raw.at.trim()) return 'at is a tool call id or message id from an update.'
    args.at = raw.at.trim()
  }
  for (const key of ['offset', 'limit'] as const) {
    const v = raw[key]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return `${key} is a whole number, 0 or more.`
    args[key] = v
  }
  if (raw.query !== undefined) {
    if (typeof raw.query !== 'string' || !raw.query.trim()) return 'query is a non-empty string.'
    args.query = raw.query.trim()
  }
  return args
}

const hasPointer = (m: ChatMessage, at: string) => m.id === at || (m.toolCalls?.some((t) => t.id === at) ?? false)

const matches = (m: ChatMessage, q: string) =>
  m.content.toLowerCase().includes(q) ||
  (m.toolCalls?.some((t) => t.input.toLowerCase().includes(q) || (t.output ?? '').toLowerCase().includes(q)) ?? false)

/** The window of `messages` to return. Indexes are into the searched list when `query` is set. Pure. */
export function readChildWindow(
  all: readonly ChatMessage[],
  args: Omit<ReadChildArgs, 'childId'>,
): { messages: ChatMessage[]; start: number; total: number; nextOffset: number | null; pointerFound: boolean | null } {
  const list = args.query ? all.filter((m) => matches(m, args.query!.toLowerCase())) : all
  const limit = Math.min(Math.max(args.limit ?? READ_CHILD_DEFAULT_LIMIT, 1), READ_CHILD_MAX_LIMIT)
  let start: number
  let pointerFound: boolean | null = null
  if (args.offset !== undefined) start = args.offset
  else if (args.at) {
    const i = list.findIndex((m) => hasPointer(m, args.at!))
    pointerFound = i >= 0
    start = i >= 0 ? i : Math.max(0, list.length - limit)
  } else start = Math.max(0, list.length - limit)
  start = Math.min(start, list.length)
  const end = Math.min(start + limit, list.length)
  return {
    messages: list.slice(start, end),
    start,
    total: list.length,
    nextOffset: end < list.length ? end : null,
    pointerFound,
  }
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}... (${text.length - max} more characters)` : text

const isReport = (t: ToolCall) => /report_to_hub$/.test(t.name)

function toolView(t: ToolCall) {
  const whole = isReport(t)
  return {
    id: t.id,
    name: t.name,
    input: whole ? t.input : clip(t.input, TOOL_CLIP),
    ...(t.output !== undefined ? { output: whole ? t.output : clip(t.output, TOOL_CLIP) } : {}),
    ...(t.isError ? { isError: true } : {}),
  }
}

/** The child's native subagents (Agent and Task calls of its own agent) with their results. */
function subagentRows(all: readonly ChatMessage[]) {
  return all.flatMap((m) =>
    (m.toolCalls ?? [])
      .filter((t) => !t.parentToolCallId && isSubagentToolName(t.name))
      .map((t) => ({
        id: t.id,
        input: clip(t.input, SUBAGENT_CLIP),
        status: t.output === undefined ? 'running' : t.isError ? 'failed' : 'done',
        ...(t.output !== undefined ? { result: clip(t.output, SUBAGENT_CLIP) } : {}),
      })),
  )
}

export interface ReadChildContext {
  /** The caller's root conversation id. */
  parentId: string
  load(childId: string): Promise<ChatMessage[]>
  /** A path exists; replaceable in tests. */
  exists?(path: string): boolean
}

export async function readChild(ctx: ReadChildContext, raw: Record<string, unknown>): Promise<McpToolResult> {
  const args = parseReadChildArgs(raw)
  if (typeof args === 'string') return toolText(args, true)
  const span = perfSpan('hub.read-child', { parentId: ctx.parentId, childId: args.childId, search: !!args.query })
  const child = getHubChild(args.childId)
  if (!child || child.parentId !== resolveRootThreadId(ctx.parentId)) {
    span.end({ outcome: 'not_own' })
    return toolText(`${args.childId} is not a child of this chat. list_children shows your children.`, true)
  }
  const wake = lastHubWakeOf(child.childId)
  const path = wake?.pointer?.transcriptPath
  // A transcript file the pointer named is the record: without it, only the summary is left.
  if (path && !(ctx.exists ?? existsSync)(path)) {
    span.end({ outcome: 'gone' })
    const left = wake ? ` Only its summary is left: ${wake.summary}` : ''
    return toolText(`The transcript of ${child.title} is gone (${path}).${left}`)
  }
  let all: ChatMessage[]
  try {
    all = await ctx.load(child.childId)
  } catch (err) {
    log.warn(`could not load the history of child ${child.childId}`, err)
    span.end({ outcome: 'error' })
    return toolText(`Could not read the history of ${child.title}. Try again in a moment.`, true)
  }
  const w = readChildWindow(all, args)
  const reply = JSON.stringify(
    {
      childId: child.childId,
      title: child.title,
      total: w.total,
      offset: w.start,
      nextOffset: w.nextOffset,
      ...(w.pointerFound === false ? { note: `${args.at} was not found; these are the newest messages.` } : {}),
      messages: w.messages.map((m) => ({
        id: m.id,
        role: m.role,
        at: new Date(m.timestamp).toISOString(),
        text: m.content,
        ...(m.toolCalls?.length ? { tools: m.toolCalls.map(toolView) } : {}),
      })),
      subagents: subagentRows(all),
    },
    null,
    2,
  )
  span.end({ outcome: 'ok', messages: w.messages.length, total: w.total, bytes: Buffer.byteLength(reply) })
  return toolText(reply)
}

/**
 * A subagent's rows fold into its Agent/Task row, by the shared rule in
 * `@shared/subagent-steps` (desktop and Android use the same one). The agent
 * row carries its view; its steps leave the feed. A backend that sends no
 * `parentToolCallId` leaves every step where it was.
 */
import {
  groupSubagentEntries,
  isSubagentToolName,
  subagentView,
  type SubagentEntryFacts,
  type SubagentStep,
  type SubagentView,
} from '@shared/subagent-steps'
import type { FeedItem } from '../stores/chat'
import type { FeedRow } from './file-groups'

type ToolItem = Extract<FeedItem, { kind: 'tool' }>

export interface SubagentRow {
  kind: 'subagent'
  id: string
  view: SubagentView
  /** The feed rows behind the view's steps, by step key, to render them when expanded. */
  stepRows: ReadonlyMap<string, FeedItem>
}

export type ThreadRow = FeedRow | SubagentRow

/** The provider's tool id: live rows are `t-<id>`, history rows `h-<message>-t-<id>`. */
export function feedToolId(item: ToolItem): string {
  return item.id.startsWith('t-') ? item.id.slice(2) : item.id.slice(item.id.lastIndexOf('-t-') + 3)
}

function facts(row: FeedRow): SubagentEntryFacts {
  if (row.kind === 'tool') {
    return { toolCalls: [{ id: feedToolId(row), name: row.toolName, parentToolCallId: row.parentToolCallId }] }
  }
  if (row.kind === 'text') return { parentToolCallId: row.parentToolCallId }
  if (row.kind === 'synthetic' && row.part.kind === 'task-notification') return { noticeToolUseId: row.part.toolUseId }
  return {}
}

function parsedInput(input: unknown): unknown {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function toStep(row: FeedItem): SubagentStep | null {
  if (row.kind === 'tool') {
    return {
      kind: 'tool',
      key: row.id,
      toolName: row.toolName,
      input: parsedInput(row.input),
      ...(row.output !== undefined ? { output: row.output } : {}),
      ...(row.isError ? { isError: true } : {}),
    }
  }
  if (row.kind === 'synthetic' && row.part.kind === 'task-notification') {
    return { kind: 'notice', key: row.id, part: row.part }
  }
  if (row.kind === 'text') return { kind: 'text', key: row.id, text: row.text }
  return null
}

/** Each Agent/Task row becomes a `subagent` row; its steps leave the feed. */
export function collapseSubagents(rows: readonly FeedRow[]): ThreadRow[] {
  const grouping = groupSubagentEntries(rows, facts)
  return grouping.topLevel.map((row): ThreadRow => {
    if (row.kind !== 'tool' || !isSubagentToolName(row.toolName)) return row
    const toolId = feedToolId(row)
    const stepRows = new Map<string, FeedItem>()
    for (const step of grouping.stepsByAgent.get(toolId) ?? [])
      if (step.kind !== 'fileGroup') stepRows.set(step.id, step)
    const steps = [...stepRows.values()].map(toStep).filter((step) => step !== null)
    const completions = (grouping.completionsByAgent.get(toolId) ?? []).flatMap((done) =>
      done.kind === 'synthetic' && done.part.kind === 'task-notification' ? [{ part: done.part }] : [],
    )
    const view = subagentView(
      {
        input: parsedInput(row.input),
        output: row.output,
        ...(row.isError ? { isError: true } : {}),
      },
      steps,
      completions,
    )
    return { kind: 'subagent', id: `agent:${row.id}`, view, stepRows }
  })
}

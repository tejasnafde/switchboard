/**
 * A subagent's work belongs to the Agent/Task call that started it. Providers
 * stamp each of the subagent's tool calls with that call's id
 * (`parentToolCallId`), and a background task notice names the call that
 * started the task (`toolUseId`). This module places every such entry under
 * its agent, never at the top level, and builds the one-row view each surface
 * renders: status, step count, folded steps and the final report.
 *
 * Pure and surface-neutral: the desktop feeds it `ChatMessage`s, the Expo app
 * its feed items, through `facts`. Android ports it (`SubagentSteps.kt`), and
 * both run `tests/fixtures/subagent-cases.json`.
 */
import { backgroundTaskLabel, cutLabel, type SyntheticUserPart } from './synthetic-message'
import { summarizeTool } from './tool-summary'

export type TaskNoticePart = Extract<SyntheticUserPart, { kind: 'task-notification' }>

export function isSubagentToolName(name: string): boolean {
  const key = name.toLowerCase()
  return key === 'agent' || key === 'task'
}

/** What the grouping needs to know about one feed entry, whatever its shape. */
export interface SubagentEntryFacts {
  toolCalls?: ReadonlyArray<{ id: string; name: string; parentToolCallId?: string }>
  /** A subagent's own text: the call it belongs to. */
  parentToolCallId?: string
  /** A task notice: the tool call that started the task. */
  noticeToolUseId?: string
}

export interface SubagentGrouping<T> {
  /** Everything that is not a subagent's, in feed order. */
  topLevel: T[]
  /**
   * Each top-level Agent/Task call's steps, in feed order. One level only: a
   * subagent's own subagents put their steps here too, under the top one.
   */
  stepsByAgent: Map<string, T[]>
  /** A background subagent's own notices (it finished, failed or stopped). */
  completionsByAgent: Map<string, T[]>
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * Split a feed into its top level and each agent's steps. An entry whose
 * agent is not in the feed (a history window that starts after the Agent
 * call) stays at the top level, as it was before grouping existed.
 */
export function groupSubagentEntries<T>(
  entries: readonly T[],
  facts: (entry: T) => SubagentEntryFacts,
): SubagentGrouping<T> {
  const known = entries.map(facts)
  const callName = new Map<string, string>()
  const callParent = new Map<string, string | undefined>()
  for (const fact of known) {
    for (const call of fact.toolCalls ?? []) {
      callName.set(call.id, call.name)
      callParent.set(call.id, call.parentToolCallId ?? fact.parentToolCallId)
    }
  }
  // The topmost agent at or above `start` among the calls in the feed.
  const rootAgent = (start: string | undefined): string | undefined => {
    let root: string | undefined
    const seen = new Set<string>()
    for (let id = start; id !== undefined && callName.has(id) && !seen.has(id); id = callParent.get(id)) {
      seen.add(id)
      if (isSubagentToolName(callName.get(id)!)) root = id
    }
    return root
  }

  const grouping: SubagentGrouping<T> = { topLevel: [], stepsByAgent: new Map(), completionsByAgent: new Map() }
  entries.forEach((entry, index) => {
    const fact = known[index]
    if (fact.noticeToolUseId !== undefined) {
      const root = rootAgent(fact.noticeToolUseId)
      if (root === fact.noticeToolUseId) push(grouping.completionsByAgent, root, entry)
      else if (root !== undefined) push(grouping.stepsByAgent, root, entry)
      else grouping.topLevel.push(entry)
      return
    }
    const parent = fact.parentToolCallId ?? fact.toolCalls?.find((call) => call.parentToolCallId)?.parentToolCallId
    const root = rootAgent(parent)
    if (root !== undefined) push(grouping.stepsByAgent, root, entry)
    else grouping.topLevel.push(entry)
  })
  return grouping
}

// ─── One agent's row ─────────────────────────────────────────────

export type SubagentStep =
  | { kind: 'tool'; key: string; toolName: string; input: unknown; output?: string; isError?: boolean }
  | { kind: 'notice'; key: string; part: TaskNoticePart }
  | { kind: 'text'; key: string; text: string }

export type SubagentDisplayItem =
  /** `failed` marks the step the agent failed on; its output is shown open. */
  | { kind: 'step'; step: SubagentStep; failed?: boolean }
  /** A long middle run, folded: "N more steps". */
  | { kind: 'more'; key: string; label: string; steps: SubagentStep[] }
  /** Consecutive notices, folded: "N background tasks completed". */
  | { kind: 'notices'; key: string; label: string; steps: Array<Extract<SubagentStep, { kind: 'notice' }>> }

export interface SubagentCall {
  input: unknown
  output?: string
  isError?: boolean
  /** When the call started, for a background agent's duration. */
  startedAt?: number
}

export interface SubagentCompletion {
  part: TaskNoticePart
  at?: number
}

export type SubagentStatus = 'running' | 'done' | 'failed'

export interface SubagentView {
  description: string
  /** The model the call asked for ("haiku"), when it named one. */
  model?: string
  status: SubagentStatus
  stepCount: number
  /** Running: what the latest step is doing. */
  currentStep?: string
  /** Failed: why, in one line. */
  failureReason?: string
  durationMs?: number
  /** Done: the subagent's final report. */
  result?: string
  items: SubagentDisplayItem[]
}

const ASYNC_LAUNCH = /^Async agent launched/

/** The result of a background agent call: the agent runs on until its completion notice. */
export const isAsyncAgentLaunch = (output: string): boolean => ASYNC_LAUNCH.test(output)

const AGENT_TRAILER = /(?:^|\n)agentId: \S+[^\n]*(?:\n<usage>[\s\S]*?<\/usage>)?\s*$/
const TOOL_ERROR_TAGS = /<\/?tool_use_error>/g

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function usageNumber(output: string, field: string): number | undefined {
  const usage = /<usage>([\s\S]*?)<\/usage>/.exec(output)?.[1]
  const value = usage && new RegExp(`${field}:\\s*(\\d+)`).exec(usage)?.[1]
  return value ? Number(value) : undefined
}

/** The report a finished call returned, without the agent id and usage the CLI appends. */
export function subagentResultText(output: string): string {
  return output.replace(AGENT_TRAILER, '').trim()
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  )
}

export function subagentStepLabel(step: SubagentStep): string {
  switch (step.kind) {
    case 'tool': {
      const summary = summarizeTool(step.toolName, step.input)
      return summary.detail || summary.title
    }
    case 'notice':
      return backgroundTaskLabel(step.part.summary)
    case 'text':
      return cutLabel(firstLine(step.text))
  }
}

/** Fewer middle steps than this stay visible; folding two saves nothing. */
const MIN_FOLD = 3

function noticeGroupLabel(steps: Array<Extract<SubagentStep, { kind: 'notice' }>>): string {
  const failed = steps.filter((step) => step.part.status === 'failed').length
  if (failed > 0) return `${steps.length} background tasks, ${failed} failed`
  const allCompleted = steps.every((step) => step.part.status === 'completed')
  return `${steps.length} background tasks ${allCompleted ? 'completed' : 'finished'}`
}

/**
 * The rows under an expanded agent: consecutive notices fold into one, the
 * first and last steps stay, and a middle run of `MIN_FOLD` or more plain
 * steps folds into "N more steps". The failed step is never folded.
 */
export function subagentDisplayItems(steps: readonly SubagentStep[], failedKey?: string): SubagentDisplayItem[] {
  const units: SubagentDisplayItem[] = []
  for (const step of steps) {
    const previous = units.at(-1)
    if (step.kind === 'notice') {
      if (previous?.kind === 'notices') {
        previous.steps.push(step)
        previous.label = noticeGroupLabel(previous.steps)
        continue
      }
      if (previous?.kind === 'step' && previous.step.kind === 'notice') {
        const group = [previous.step, step]
        units[units.length - 1] = {
          kind: 'notices',
          key: previous.step.key,
          label: noticeGroupLabel(group),
          steps: group,
        }
        continue
      }
    }
    units.push({ kind: 'step', step, ...(step.key === failedKey ? { failed: true } : {}) })
  }

  const items: SubagentDisplayItem[] = []
  let run: SubagentStep[] = []
  const flush = () => {
    if (run.length >= MIN_FOLD) {
      items.push({ kind: 'more', key: `more:${run[0].key}`, label: `${run.length} more steps`, steps: run })
    } else {
      for (const step of run) items.push({ kind: 'step', step })
    }
    run = []
  }
  units.forEach((unit, index) => {
    const middle = index > 0 && index < units.length - 1
    if (middle && unit.kind === 'step' && !unit.failed && unit.step.kind !== 'notice') {
      run.push(unit.step)
      return
    }
    flush()
    items.push(unit)
  })
  flush()
  return items
}

function completionReason(part: TaskNoticePart): string {
  if (part.status !== 'failed') return 'Stopped'
  const after = /failed:?\s*(.*)$/s.exec(part.summary)?.[1]
  return cutLabel(firstLine(after || part.summary) || 'Failed')
}

/**
 * The row for one Agent/Task call. Its status comes from the call's result
 * (an error result is a failure), else, for a background agent whose result
 * is only the launch notice, from its last completion notice.
 */
export function subagentView(
  call: SubagentCall,
  steps: readonly SubagentStep[],
  completions: readonly SubagentCompletion[] = [],
): SubagentView {
  const input = call.input !== null && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
  const description =
    str(input.description) ?? (str(input.prompt) && cutLabel(firstLine(str(input.prompt)!))) ?? 'Subagent'
  const model = str(input.model)
  const output = call.output
  const launched = output !== undefined && ASYNC_LAUNCH.test(output)
  const completion = completions.at(-1)

  let status: SubagentStatus = 'running'
  let failureReason: string | undefined
  let result: string | undefined
  if (call.isError) {
    status = 'failed'
    failureReason = cutLabel(firstLine((output ?? '').replace(TOOL_ERROR_TAGS, '')) || 'Failed')
  } else if (output !== undefined && !launched) {
    status = 'done'
    result = subagentResultText(output) || undefined
  } else if (completion) {
    status = completion.part.status === 'completed' ? 'done' : 'failed'
    if (status === 'failed') failureReason = completionReason(completion.part)
    else result = completion.part.result
  }

  let failedKey: string | undefined
  for (let i = steps.length - 1; status === 'failed' && i >= 0 && failedKey === undefined; i--) {
    const step = steps[i]
    if (step.kind === 'tool' && step.isError) failedKey = step.key
  }
  const usageSource = output !== undefined && !launched ? output : undefined
  const usageDuration = usageSource !== undefined ? usageNumber(usageSource, 'duration_ms') : undefined
  const completedAt = status !== 'running' && !usageSource ? completion?.at : undefined
  const durationMs =
    usageDuration ??
    (completedAt !== undefined && call.startedAt !== undefined && completedAt > call.startedAt
      ? completedAt - call.startedAt
      : undefined)
  const last = steps.at(-1)
  return {
    description,
    ...(model ? { model } : {}),
    status,
    stepCount: steps.length || (usageSource !== undefined ? usageNumber(usageSource, 'tool_uses') : undefined) || 0,
    ...(status === 'running' && last ? { currentStep: subagentStepLabel(last) } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(result ? { result } : {}),
    items: subagentDisplayItems(steps, failedKey),
  }
}

/** "42s", "6m 02s", "1h 05m". */
export function formatSubagentDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const pad = (n: number) => String(n).padStart(2, '0')
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`
}

export interface SubagentStatusParts {
  /** "Step 7", "Done" or "Failed". */
  lead: string
  /** The running step, or the failure reason. */
  detail?: string
  /** Step count and duration. */
  meta: string[]
}

export function subagentStatusParts(view: SubagentView): SubagentStatusParts {
  const steps = `${view.stepCount} ${view.stepCount === 1 ? 'step' : 'steps'}`
  if (view.status === 'running') {
    return {
      lead: view.stepCount > 0 ? `Step ${view.stepCount}` : 'Starting',
      ...(view.currentStep ? { detail: view.currentStep } : {}),
      meta: [],
    }
  }
  const meta = view.stepCount > 0 ? [steps] : []
  if (view.status === 'failed')
    return { lead: 'Failed', ...(view.failureReason ? { detail: view.failureReason } : {}), meta }
  return {
    lead: 'Done',
    meta: view.durationMs !== undefined ? [...meta, formatSubagentDuration(view.durationMs)] : meta,
  }
}

/** The status as one line: "Step 7 · npx vitest", "Done · 14 steps · 6m 02s". */
export function subagentStatusText(view: SubagentView): string {
  const parts = subagentStatusParts(view)
  return [parts.lead, parts.detail, ...parts.meta].filter(Boolean).join(' · ')
}

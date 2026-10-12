/**
 * Shared vectors for subagent grouping, rows and background task labels. The
 * native Android test (SubagentStepsFixturesTest.kt) reads the same file.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import {
  groupSubagentEntries,
  subagentStatusText,
  subagentView,
  type SubagentCall,
  type SubagentCompletion,
  type SubagentDisplayItem,
  type SubagentEntryFacts,
  type SubagentStep,
} from '../../src/shared/subagent-steps'
import { backgroundTaskLabel, splitSyntheticUserText, taskNotificationText } from '../../src/shared/synthetic-message'

interface Fixture {
  labels: Array<{ id: string; summary: string; label: string }>
  groupings: Array<{
    id: string
    entries: Array<SubagentEntryFacts & { key: string }>
    expected: { topLevel: string[]; steps: Record<string, string[]>; completions: Record<string, string[]> }
  }>
  views: Array<{
    id: string
    call: SubagentCall
    steps: SubagentStep[]
    completions: SubagentCompletion[]
    expected: {
      description: string
      model?: string
      status: string
      statusText: string
      result?: string
      items: string[]
    }
  }>
}

const here = dirname(fileURLToPath(import.meta.url))
const fixture: Fixture = JSON.parse(readFileSync(resolve(here, '../fixtures/subagent-cases.json'), 'utf8'))

const keys = (map: Map<string, Array<{ key: string }>>) =>
  Object.fromEntries([...map].map(([agent, entries]) => [agent, entries.map((entry) => entry.key)]))

/** The fixture's string form of a row: `step:<key>`, `failed:<key>`, `more:<label>`, `notices:<label>`. */
export function itemCode(item: SubagentDisplayItem): string {
  if (item.kind === 'step') return `${item.failed ? 'failed' : 'step'}:${item.step.key}`
  return `${item.kind}:${item.label}`
}

describe('subagent-cases: background task labels', () => {
  it.each(fixture.labels.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(backgroundTaskLabel(c.summary)).toBe(c.label)
  })
})

describe('subagent-cases: grouping', () => {
  it.each(fixture.groupings.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const grouping = groupSubagentEntries(c.entries, (entry) => entry)
    expect({
      topLevel: grouping.topLevel.map((entry) => entry.key),
      steps: keys(grouping.stepsByAgent),
      completions: keys(grouping.completionsByAgent),
    }).toEqual(c.expected)
  })
})

describe('subagent-cases: rows', () => {
  it.each(fixture.views.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const view = subagentView(c.call, c.steps, c.completions)
    expect({
      description: view.description,
      ...(view.model ? { model: view.model } : {}),
      status: view.status,
      statusText: subagentStatusText(view),
      ...(view.result ? { result: view.result } : {}),
      items: view.items.map(itemCode),
    }).toEqual(c.expected)
  })
})

describe('task notice tool-use id', () => {
  it('round-trips through the transcript form', () => {
    const text = taskNotificationText({ taskId: 't1', status: 'completed', summary: 's', toolUseId: 'toolu_1' })
    const part = splitSyntheticUserText(text)?.parts[0]
    expect(part).toMatchObject({ kind: 'task-notification', taskId: 't1', toolUseId: 'toolu_1' })
  })

  it('reads the result a transcript line carries', () => {
    const text =
      '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n<result>Report.</result>\n</task-notification>'
    expect(splitSyntheticUserText(text)?.parts[0]).toMatchObject({ toolUseId: 'toolu_9', result: 'Report.' })
  })
})

// @vitest-environment jsdom
/**
 * The desktop agent row: collapsed by default behind a real button, steps
 * folded when expanded, and a failed agent naming its reason in the row and
 * showing the failing step's output last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatMessage, ToolCall } from '../../src/shared/types'

vi.mock('../../src/renderer/components/chat/visuals/MessageMarkdown', () => ({
  MessageMarkdown: ({ markdown }: { markdown: string }) => createElement('div', { 'data-markdown': true }, markdown),
}))

const { SubagentRow } = await import('../../src/renderer/components/chat/SubagentRow')
const { groupChatSubagents } = await import('../../src/renderer/components/chat/subagent-messages')
const { projectTurnPresentation } = await import('../../src/renderer/components/chat/turn-presentation')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const agent = (output?: string, isError?: true): ToolCall => ({
  id: 'toolu_agent',
  name: 'Agent',
  input: JSON.stringify({ description: 'Audit apps/mobile dependencies', model: 'sonnet' }),
  ...(output !== undefined ? { output } : {}),
  ...(isError ? { isError } : {}),
})

const step = (id: string, command: string, output?: string, isError?: true): ChatMessage => ({
  id: `tool_t:${id}`,
  role: 'assistant',
  content: '',
  timestamp: 1,
  toolCalls: [
    {
      id,
      name: 'Bash',
      input: JSON.stringify({ command }),
      parentToolCallId: 'toolu_agent',
      ...(output !== undefined ? { output } : {}),
      ...(isError ? { isError } : {}),
    },
  ],
})

function render(call: ToolCall, steps: ChatMessage[]) {
  act(() => root.render(createElement(SubagentRow, { call, startedAt: 0, steps, completions: [] })))
}

const trigger = () => container.querySelector('[data-subagent-row] > button') as HTMLButtonElement
const status = () => container.querySelector('[data-subagent-status]')

describe('SubagentRow', () => {
  it('starts collapsed behind a button and toggles its steps', () => {
    render(agent(), [step('s1', 'npm audit', 'ok'), step('s2', 'npx expo-doctor')])
    expect(trigger().type).toBe('button')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().textContent).toContain('Agent')
    expect(trigger().textContent).toContain('Audit apps/mobile dependencies')
    expect(trigger().textContent).toContain('sonnet')
    expect(status()?.getAttribute('data-subagent-status')).toBe('running')
    expect(status()?.textContent).toBe('Step 2 · npx expo-doctor')
    expect(container.querySelector('.tool-call-row')).toBeNull()

    act(() => trigger().click())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    const region = document.getElementById(trigger().getAttribute('aria-controls')!)
    expect(region?.querySelectorAll('.tool-call-row')).toHaveLength(2)

    act(() => trigger().click())
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.tool-call-row')).toBeNull()
  })

  it('names a failure in the row and shows the failing step and its output last', () => {
    render(agent('<tool_use_error>expo-doctor exited 1</tool_use_error>', true), [
      step('s1', 'cat apps/mobile/package.json', 'ok'),
      step('s2', 'npm audit', 'ok'),
      step('s3', 'npm ls', 'ok'),
      step('s4', 'npm outdated', 'ok'),
      step('s5', 'npx expo-doctor', 'Exit code 1\n1 check failed, 14 passed.', true),
    ])
    expect(status()?.getAttribute('data-subagent-status')).toBe('failed')
    expect(status()?.textContent).toBe('Failed · expo-doctor exited 1 · 5 steps')

    act(() => trigger().click())
    const buttons = [...container.querySelectorAll('[data-subagent-row] button')].map((b) => b.textContent ?? '')
    expect(buttons.some((text) => text.includes('3 more steps'))).toBe(true)
    const rows = container.querySelectorAll('.tool-call-row')
    expect(rows).toHaveLength(2)
    expect(rows[1].textContent).toContain('Exit 1')
    expect(container.textContent).toContain('1 check failed, 14 passed.')

    const more = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('3 more steps'))!
    act(() => more.click())
    expect(container.querySelectorAll('.tool-call-row')).toHaveLength(5)
  })

  it('shows a finished agent with its duration and its report last', () => {
    render(
      agent('Combined the PRs.\nagentId: a1 (use SendMessage)\n<usage>tool_uses: 1\nduration_ms: 362000</usage>'),
      [step('s1', 'git push', 'pushed')],
    )
    expect(status()?.textContent).toBe('Done · 1 step · 6m 02s')
    act(() => trigger().click())
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('Combined the PRs.')
  })
})

describe('agent rows in a turn', () => {
  it("keep a subagent's rows out of the turn and the agent call out of Used N tools", () => {
    const call = agent()
    const messages: ChatMessage[] = [
      { id: 'u', role: 'user', content: 'Fix it', timestamp: 0 },
      { id: 'read', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'r', name: 'Read', input: '{}' }] },
      { id: 'a', role: 'assistant', content: '', timestamp: 2, toolCalls: [call] },
      step('s1', 'npm ls'),
      {
        id: 'notice',
        role: 'user',
        content:
          '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>s1</tool-use-id>\n<status>completed</status>\n<summary>Background command "npm ls" completed</summary>\n</task-notification>',
        timestamp: 3,
      },
      { id: 'done', role: 'assistant', content: 'Both are back.', timestamp: 4 },
    ]
    const grouping = groupChatSubagents(messages)
    expect(grouping.topLevel.map((m) => m.id)).toEqual(['u', 'read', 'a', 'done'])
    expect(grouping.stepsByAgent.get('toolu_agent')?.map((m) => m.id)).toEqual(['tool_t:s1', 'notice'])
    expect(projectTurnPresentation(grouping.topLevel.slice(1)).map((item) => item.kind)).toEqual([
      'activity',
      'subagents',
      'message',
    ])
  })
})

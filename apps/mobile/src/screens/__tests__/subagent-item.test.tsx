/**
 * The phone's agent row: collapsed with its status, the failure named in the
 * row, and a tap that opens the steps. The grouping rule is shared and tested
 * in the root vitest suite (tests/unit/subagent-steps.test.ts).
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { SubagentItem } from '../SubagentItem'
import { collapseSubagents, type SubagentRow } from '../../lib/subagent-rows'
import type { FeedItem } from '../../stores/chat'
import { renderComponent } from '../../test/render'

const agent = (output?: string, isError?: boolean): FeedItem => ({
  kind: 'tool',
  id: 't-toolu_agent',
  toolName: 'Agent',
  input: { description: 'Audit apps/mobile dependencies', model: 'sonnet' },
  state: output === undefined ? 'running' : 'done',
  ...(output !== undefined ? { output } : {}),
  ...(isError ? { isError } : {}),
})

const step = (id: string, command: string, output?: string, isError?: boolean): FeedItem => ({
  kind: 'tool',
  id: `t-${id}`,
  toolName: 'Bash',
  input: { command },
  state: output === undefined ? 'running' : 'done',
  parentToolCallId: 'toolu_agent',
  ...(output !== undefined ? { output } : {}),
  ...(isError ? { isError } : {}),
})

function row(items: FeedItem[]): SubagentRow {
  const rows = collapseSubagents(items)
  expect(rows).toHaveLength(1)
  return rows[0] as SubagentRow
}

describe('SubagentItem', () => {
  it('shows a running agent collapsed, with its step count and current step', () => {
    const v = renderComponent(
      <SubagentItem row={row([agent(), step('s1', 'npm audit', 'ok'), step('s2', 'npx expo-doctor')])} />,
    )
    const text = v.texts().join('')
    expect(text).toContain('Agent')
    expect(text).toContain('Audit apps/mobile dependencies')
    expect(text).toContain('sonnet')
    expect(text).toContain('Step 2')
    expect(text).toContain('npx expo-doctor')
    expect(v.root.findAllByProps({ testID: 'subagent-running' }).length).toBeGreaterThan(0)
    expect(text).not.toContain('npm audit')
  })

  it('names a failure in the row and opens to the failing step and its output', () => {
    const v = renderComponent(
      <SubagentItem
        row={row([
          agent('<tool_use_error>expo-doctor exited 1</tool_use_error>', true),
          step('s1', 'npm audit', 'ok'),
          step('s2', 'npx expo-doctor', 'Exit code 1\n1 check failed', true),
        ])}
      />,
    )
    expect(v.texts().join('')).toContain('Failed')
    expect(v.texts().join('')).toContain('expo-doctor exited 1 · 2 steps')
    expect(v.root.findAllByProps({ testID: 'subagent-failed' }).length).toBeGreaterThan(0)
    const header = v.byLabel(/^Agent Audit apps\/mobile dependencies, Failed/)
    expect(header.props.accessibilityState).toEqual({ expanded: false })
    act(() => header.props.onPress())
    expect(v.byLabel(/^Agent Audit/).props.accessibilityState).toEqual({ expanded: true })
    const opened = v.texts().join('')
    expect(opened).toContain('npm audit')
    expect(opened).toContain('Exit code 1\n1 check failed')
  })

  it('shows a finished agent with its duration and its report when opened', () => {
    const v = renderComponent(
      <SubagentItem
        row={row([
          agent('All clear.\nagentId: a1 (use SendMessage)\n<usage>tool_uses: 1\nduration_ms: 42000</usage>'),
          step('s1', 'npm audit', 'ok'),
        ])}
      />,
    )
    expect(v.texts().join('')).toContain('1 step · 42s')
    expect(v.root.findAllByProps({ testID: 'subagent-done' }).length).toBeGreaterThan(0)
    act(() => v.byLabel(/^Agent Audit/).props.onPress())
    expect(v.texts().join('')).toContain('All clear.')
  })
})

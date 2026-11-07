import React from 'react'
import { AgentChip } from '../../screens/ConversationsScreen'
import { renderComponent } from '../../test/render'

const row = (over: { agent_type: string; origin_source?: string | null }) =>
  ({
    id: 'thread-1',
    title: 'Fix mobile UI',
    updated_at: 0,
    status_line: null,
    worktree_path: null,
    ...over,
  }) as never

it('draws the mark and no text for an agent that has one', () => {
  const view = renderComponent(<AgentChip row={row({ agent_type: 'codex' })} />)
  expect(view.byLabel('Codex')).toBeTruthy()
  expect(view.texts()).toEqual([])
})

it('names a Cursor import instead of claiming it is Claude', () => {
  // A Cursor import is stored as claude-code, so the raw agent type would draw Claude's mark.
  const view = renderComponent(<AgentChip row={row({ agent_type: 'claude-code', origin_source: 'cursor' })} />)
  expect(view.texts()).toEqual(['Cursor'])
  expect(view.countHostType('RNSVGSvgView')).toBe(0)
})

it('names an agent this build does not know', () => {
  const view = renderComponent(<AgentChip row={row({ agent_type: 'some-future-agent' })} />)
  expect(view.texts()).toEqual(['some-future-agent'])
})

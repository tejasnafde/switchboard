import React from 'react'
import { AgentMark } from '../AgentMark'
import { renderComponent } from '../../test/render'

it('draws the agent mark and names the agent', () => {
  const view = renderComponent(<AgentMark agent="opencode" />)
  expect(view.byLabel('OpenCode')).toBeTruthy()
  expect(view.countHostType('RNSVGPath')).toBe(1)
})

it('takes the wire spelling of Claude', () => {
  const view = renderComponent(<AgentMark agent="claude" />)
  expect(view.byLabel('Claude Code')).toBeTruthy()
})

it('draws nothing for an agent with no published mark', () => {
  const view = renderComponent(<AgentMark agent="acp-command" />)
  expect(view.allByLabel(/./)).toEqual([])
})

/**
 * The feed rows, rendered.
 *
 * Every test here corresponds to a bug that reached the device, because the
 * render layer had no coverage at all. They are the cheap regression net for
 * "the state is right in the store but wrong on screen".
 */
import React from 'react'
import { ToolItem, TextItem } from '../ThreadScreen'
import type { FeedItem } from '../../stores/chat'
import { renderComponent } from '../../test/render'

type Tool = Extract<FeedItem, { kind: 'tool' }>
type TextRow = Extract<FeedItem, { kind: 'text' }>

const tool = (over: Partial<Tool> = {}): Tool => ({
  kind: 'tool',
  id: 't-1',
  toolName: 'Bash',
  input: { command: 'npm run typecheck' },
  state: 'done',
  output: 'ok',
  ...over,
})

describe('ToolItem', () => {
  it('spins only while running', () => {
    // Reported twice: every card spinning forever. The cause was the Claude
    // adapter never emitting tool.completed, but the render contract is this.
    const running = renderComponent(<ToolItem item={tool({ state: 'running' })} />)
    expect(running.countHostType('ActivityIndicator')).toBe(1)

    const done = renderComponent(<ToolItem item={tool({ state: 'done' })} />)
    expect(done.countHostType('ActivityIndicator')).toBe(0)
  })

  it('shows the command, not the JSON around it', () => {
    const v = renderComponent(<ToolItem item={tool()} />)
    const text = v.texts().join(' ')
    expect(text).toContain('npm run typecheck')
    expect(text).not.toContain('{')
  })

  it('picks an icon that matches the tool', () => {
    expect(renderComponent(<ToolItem item={tool({ toolName: 'Bash' })} />).iconNames()).toContain('terminal')
    expect(renderComponent(<ToolItem item={tool({ toolName: 'Grep', input: { pattern: 'x' } })} />).iconNames()).toContain('search')
  })

  it('collapses output until asked, so a turn of tools stays scannable', () => {
    const v = renderComponent(<ToolItem item={tool({ output: 'line one\nline two\nline three' })} />)
    expect(v.texts().join(' ')).not.toContain('line two')
    // The chevron is the affordance that output exists.
    expect(v.iconNames()).toContain('chevron-down')
  })

  it('offers no chevron when there is nothing to expand', () => {
    const v = renderComponent(<ToolItem item={tool({ output: '' })} />)
    expect(v.iconNames()).not.toContain('chevron-down')
  })

  it('renders a tool whose input is unusable without throwing', () => {
    const v = renderComponent(<ToolItem item={tool({ toolName: 'Weird', input: null })} />)
    expect(v.texts().join(' ')).toContain('Weird')
  })
})

describe('TextItem', () => {
  const row = (over: Partial<TextRow> = {}): TextRow => ({
    kind: 'text',
    id: 'm-1',
    text: 'hello',
    stream: 'assistant',
    done: true,
    ...over,
  })

  it('renders markdown rather than its own syntax', () => {
    // Regression: replies used to show literal ** and ### on screen.
    const v = renderComponent(<TextItem item={row({ text: '## Heading\n\n**bold** text' })} />)
    const text = v.texts().join(' ')
    expect(text).toContain('Heading')
    expect(text).toContain('bold')
    expect(text).not.toContain('**')
    expect(text).not.toContain('##')
  })

  it('keeps code fences as code, without the backticks', () => {
    const v = renderComponent(<TextItem item={row({ text: '```ts\nconst a = 1\n```' })} />)
    const text = v.texts().join(' ')
    expect(text).toContain('const a = 1')
    expect(text).not.toContain('```')
  })

  it('shows the duration once a turn is done', () => {
    const v = renderComponent(<TextItem item={row({ durationMs: 1500 })} />)
    expect(v.texts().join(' ')).toMatch(/worked for/i)
  })

  it('shows no duration mid-stream', () => {
    const v = renderComponent(<TextItem item={row({ done: false })} />)
    expect(v.texts().join(' ')).not.toMatch(/worked for/i)
  })
})

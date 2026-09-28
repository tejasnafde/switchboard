/**
 * The feed rows, rendered.
 *
 * Every test here corresponds to a bug that reached the device, because the
 * render layer had no coverage at all. They are the cheap regression net for
 * "the state is right in the store but wrong on screen".
 */
import React from 'react'
import { ApprovalItem, ToolItem, TextItem } from '../ThreadFeedItems'
import type { FeedItem } from '../../stores/chat'
import { act } from 'react-test-renderer'
import type { HostWriteCard } from '@shared/agent-host-writes'
import { renderComponent, type Node } from '../../test/render'

/** Tap the Pressable around the text `label`: a plain tap, not a gesture. */
function press(root: Node, label: string): void {
  let node: Node | null = root.find((n) => typeof n.type === 'string' && n.children.length === 1 && n.children[0] === label)
  while (node && typeof node.props.onPress !== 'function') node = node.parent
  if (!node) throw new Error(`nothing pressable around "${label}"`)
  const target = node
  act(() => target.props.onPress())
}

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

  it('shows no duration mid-stream, even once one is known', () => {
    // durationMs must be SET here. Without it the row has no duration to show
    // in the first place, so the test passes with the `done` guard deleted and
    // proves only that absent data is absent.
    const v = renderComponent(<TextItem item={row({ done: false, durationMs: 1500 })} />)
    expect(v.texts().join(' ')).not.toMatch(/worked for/i)
  })

  it('strips a complete <agent_digest> tag instead of showing it raw', () => {
    const v = renderComponent(
      <TextItem item={row({ text: 'Working on it.\n\n<agent_digest>Writing tests</agent_digest>' })} />,
    )
    const text = v.texts().join(' ')
    expect(text).toContain('Working on it.')
    expect(text).not.toContain('agent_digest')
    expect(text).not.toContain('Writing tests')
  })

  it('hides a still-streaming, unclosed <agent_digest> tag', () => {
    const v = renderComponent(<TextItem item={row({ text: 'Working on it. <agent_dig', done: false })} />)
    const text = v.texts().join(' ')
    expect(text).toContain('Working on it.')
    expect(text).not.toContain('agent_dig')
  })
})

describe('ApprovalItem', () => {
  type Approval = Extract<FeedItem, { kind: 'approval' }>
  const approval = (over: Partial<Approval> = {}): Approval => ({
    kind: 'approval',
    id: 'a-1',
    requestId: 'sbmcp_1',
    toolName: 'mcp__switchboard__reply_to_conversation',
    detail: 'Reply on app #612',
    requestType: 'tool',
    state: 'pending',
    ...over,
  })

  const reply: HostWriteCard = {
    action: 'reply', agentLabel: 'Codex', host: 'github', prLabel: 'app #612', url: null,
    location: 'sync/worker.py:88', quote: null, replyText: 'Done.', suggestResolve: true, maxChars: 8000,
  }
  const review: HostWriteCard = {
    ...reply, action: 'review', location: null, replyText: undefined, suggestResolve: undefined,
    review: { summary: 'Two notes.', comments: [], verdicts: ['comment', 'approve', 'request_changes'] },
  }

  it('offers Approve and Deny for an ordinary approval', () => {
    const text = renderComponent(<ApprovalItem item={approval()} backendTakesPhoneApproval={false} onDecide={() => {}} />).texts().join(' ')
    expect(text).toContain('Approve')
    expect(text).toContain('Deny')
  })

  it('offers only Deny for a pull request write on a backend that refuses a phone approval', () => {
    const texts = renderComponent(<ApprovalItem item={approval({ hostWrite: reply })} backendTakesPhoneApproval={false} onDecide={() => {}} />).texts()
    expect(texts).not.toContain('Approve')
    expect(texts).not.toContain('Post and resolve')
    expect(texts).toContain('Deny')
    expect(texts.join(' ')).toContain('Approve this on the desktop')
  })

  it('offers only Deny for a card cached with the old desktop-only flag', () => {
    const texts = renderComponent(<ApprovalItem item={approval({ desktopOnly: true })} backendTakesPhoneApproval onDecide={() => {}} />).texts()
    expect(texts).not.toContain('Approve')
    expect(texts).toContain('Deny')
  })

  it('names the write and its action buttons, and sends the resolve choice', () => {
    const decide = jest.fn()
    const root = renderComponent(<ApprovalItem item={approval({ hostWrite: reply })} backendTakesPhoneApproval onDecide={decide} />)
    const texts = root.texts()
    expect(texts).toContain('Reply and resolve a review conversation')
    expect(texts).toContain('GitHub · app #612 · sync/worker.py:88')
    expect(texts).toContain('Post reply')
    expect(texts).toContain('Post and resolve')
    expect(texts).toContain('Deny')
    expect(texts).not.toContain('Approve')
    expect(texts.join(' ')).toContain('Edit on the desktop')
    press(root.root, 'Post and resolve')
    expect(decide).toHaveBeenCalledWith('sbmcp_1', 'approve', { resolve: true })
  })

  it('offers a review\'s verdicts, none as the primary button, and sends the one picked', () => {
    const decide = jest.fn()
    const root = renderComponent(<ApprovalItem item={approval({ hostWrite: review })} backendTakesPhoneApproval onDecide={decide} />)
    const texts = root.texts()
    expect(texts).toEqual(expect.arrayContaining(['Comment', 'Request changes', 'Approve', 'Deny']))
    press(root.root, 'Request changes')
    expect(decide).toHaveBeenCalledWith('sbmcp_1', 'approve', { verdict: 'request_changes' })
  })

  it('offers only Comment to the author', () => {
    const own: HostWriteCard = { ...review, review: { ...review.review!, verdicts: ['comment'], commentOnly: 'author' } }
    const texts = renderComponent(<ApprovalItem item={approval({ hostWrite: own })} backendTakesPhoneApproval onDecide={() => {}} />).texts()
    expect(texts).toContain('Comment')
    expect(texts).not.toContain('Approve')
    expect(texts).not.toContain('Request changes')
  })
})

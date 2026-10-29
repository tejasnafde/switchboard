/**
 * An agent's secret request on the phone: read-only. The card shows who
 * asked, the title and the instructions, says to answer on the computer, and
 * offers only Decline, which sends a deny with no value. A closed card and
 * its result row are one line with no buttons.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { SecretLine, SecretRequestItem } from '../ThreadFeedItems'
import { useChatStore, threadKey, emptyThread, type FeedItem } from '../../stores/chat'
import { systemRowItem } from '../../lib/thread-history'
import { formatApprovalResultMarker } from '@shared/agent-approval-cards'
import { renderComponent, type Node } from '../../test/render'

type Approval = Extract<FeedItem, { kind: 'approval' }>

const card = (over: Partial<Approval> = {}): Approval => ({
  kind: 'approval',
  id: 'a-sbsec_1',
  requestId: 'sbsec_1',
  toolName: 'mcp__switchboard__request_secret',
  detail: 'An agent asks for a secret. Answer it in Switchboard on your computer.',
  requestType: 'tool',
  state: 'pending',
  secretRequest: {
    name: 'TAILSCALE_AUTHKEY',
    title: 'Tailscale auth key for test VMs',
    instructions: 'Create it at https://login.tailscale.com/admin/settings/keys.',
    ttl: '24h',
  },
  ...over,
})

function press(root: Node, label: string): void {
  let node: Node | null = root.find(
    (n) => typeof n.type === 'string' && n.children.length === 1 && n.children[0] === label,
  )
  while (node && typeof node.props.onPress !== 'function') node = node.parent
  if (!node) throw new Error(`nothing pressable around "${label}"`)
  act(() => {
    node!.props.onPress()
  })
}

const resultContent = (outcome: 'done' | 'declined' | 'expired') =>
  formatApprovalResultMarker({
    requestId: 'sbsec_1',
    title: 'Secret TAILSCALE_AUTHKEY',
    outcome,
    text: 'Saved TAILSCALE_AUTHKEY.',
    delivery: 'turn',
  })

describe('SecretRequestItem', () => {
  it('shows who asked, the title, the instructions with the host, and the computer line', () => {
    const view = renderComponent(<SecretRequestItem item={card()} onDecide={() => {}} />)
    const text = view.texts().join('')
    expect(text).toContain('Asked by the agent in this chat')
    expect(text).toContain('Tailscale auth key for test VMs')
    expect(text).toContain('login.tailscale.com/admin/settings/keys')
    expect(text).not.toContain('https://')
    expect(text).toContain('Answer this on your computer.')
    expect(text).not.toMatch(/Switchboard needs/)
    expect(view.iconNames()).toEqual(['terminal-outline'])
  })

  it('has no input and no Approve', () => {
    const view = renderComponent(<SecretRequestItem item={card()} onDecide={() => {}} />)
    expect(view.countHostType('TextInput')).toBe(0)
    expect(view.texts()).not.toContain('Approve')
    expect(view.texts()).toContain('Decline')
  })

  it('declines with a deny and no value', () => {
    const onDecide = jest.fn()
    const view = renderComponent(<SecretRequestItem item={card()} onDecide={onDecide} />)
    press(view.root, 'Decline')
    expect(onDecide).toHaveBeenCalledTimes(1)
    expect(onDecide.mock.calls[0]).toEqual(['sbsec_1', 'deny'])
  })

  it('is one line once answered, with no buttons', () => {
    const saved = renderComponent(<SecretRequestItem item={card({ state: 'approve' })} onDecide={() => {}} />)
    expect(saved.texts().join('')).toBe('Saved TAILSCALE_AUTHKEY')
    const declined = renderComponent(<SecretRequestItem item={card({ state: 'deny' })} onDecide={() => {}} />)
    expect(declined.texts().join('')).toBe('Declined TAILSCALE_AUTHKEY')
    expect(declined.texts()).not.toContain('Decline')
  })
})

describe('secret result rows', () => {
  it('read Saved, Declined and expired, with no Extend or Delete now', () => {
    for (const [outcome, line] of [
      ['done', 'Saved TAILSCALE_AUTHKEY'],
      ['declined', 'Declined TAILSCALE_AUTHKEY'],
      ['expired', 'TAILSCALE_AUTHKEY expired'],
    ] as const) {
      const item = systemRowItem('apr_sbsec_1', resultContent(outcome))
      expect(item).toMatchObject({ kind: 'secretLine', id: 'h-apr_sbsec_1', name: 'TAILSCALE_AUTHKEY' })
      if (item.kind !== 'secretLine') throw new Error('not a secret line')
      const view = renderComponent(<SecretLine name={item.name} state={item.state} />)
      expect(view.texts().join('')).toBe(line)
      expect(view.texts()).not.toContain('Extend')
      expect(view.texts()).not.toContain('Delete now')
    }
  })

  it('replace the live card when the result arrives', () => {
    const key = threadKey('conn', 'chat')
    act(() => {
      useChatStore.setState({ threads: { [key]: { ...emptyThread(), items: [card()] } } })
    })
    act(() => {
      useChatStore.getState().ingestNow('conn', {
        type: 'approval.result',
        threadId: 'chat',
        messageId: 'apr_sbsec_1',
        requestId: 'sbsec_1',
        content: resultContent('declined'),
        at: 1,
      })
    })
    const items = useChatStore.getState().threads[key].items
    expect(items.map((i) => i.id)).toEqual(['h-apr_sbsec_1'])
    expect(items[0]).toMatchObject({ kind: 'secretLine', state: 'declined' })
  })
})

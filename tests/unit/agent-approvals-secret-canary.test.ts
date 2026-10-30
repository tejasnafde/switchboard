/**
 * Canary for approval cards and saved secrets: a draft that holds a live value
 * of its chat is refused before anything stores or publishes it, and a card
 * already stored with one (opened before the secret was saved) comes back
 * from recovery masked.
 */
import { describe, expect, it } from 'vitest'
import {
  AgentApprovalBroker,
  SECRET_IN_CARD_APPROVAL_REFUSAL,
  type AgentWritePlan,
} from '../../src/main/mcp/agent-approvals'
import { SecretRedactor } from '../../src/main/secrets/secret-redactor'
import { memoryApprovalCardStore, type ApprovalCardStore } from '../../src/shared/agent-approval-cards'
import type { HostWriteCard } from '../../src/shared/agent-host-writes'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const CANARY = 'sbcanary_approval_0123456789'

const hostWrite: HostWriteCard = {
  action: 'reply',
  agentLabel: 'Codex',
  host: 'github',
  prLabel: 'repo #1',
  target: { repository: 'acme/repo', number: 1 },
  url: null,
  location: 'a.ts:1',
  quote: null,
  replyText: 'done',
  maxChars: 8000,
}

function setup(store: ApprovalCardStore<AgentWritePlan> = memoryApprovalCardStore()) {
  const redactor = new SecretRedactor()
  const events: RuntimeEvent[] = []
  const puts: string[] = []
  const spied: ApprovalCardStore<AgentWritePlan> = {
    ...store,
    putCard: (card) => {
      puts.push(JSON.stringify(card))
      store.putCard(card)
    },
  }
  const broker = new AgentApprovalBroker({
    publish: (e) => events.push(e),
    store: spied,
    secrets: { redactor, scope: (chatId) => chatId },
  })
  const arm = () => redactor.add('t1', 'sec1', 'API_KEY', Buffer.from(CANARY))
  return { broker, redactor, events, puts, arm }
}

const drafts: Array<[string, { detail: string; hostWrite?: HostWriteCard; plan: AgentWritePlan }]> = [
  [
    'a pull request reply',
    {
      detail: 'reply',
      hostWrite: { ...hostWrite, replyText: `key is ${CANARY}` },
      plan: { kind: 'peer-send', sessionId: 's', message: 'x' },
    },
  ],
  ['a peer message', { detail: 'send', plan: { kind: 'peer-send', sessionId: 's2', message: `use ${CANARY}` } }],
  [
    'a secret request title',
    {
      detail: '',
      plan: { kind: 'secret-request', card: { name: 'B', title: `Paste ${CANARY}`, instructions: 'x', ttl: '1h' } },
    },
  ],
  [
    'a secret request instructions (base64)',
    {
      detail: '',
      plan: {
        kind: 'secret-request',
        card: { name: 'B', title: 't', instructions: Buffer.from(CANARY).toString('base64'), ttl: '1h' },
      },
    },
  ],
  ['the detail alone', { detail: `run with ${CANARY}`, plan: { kind: 'peer-send', sessionId: 's2', message: 'x' } }],
]

describe('approval cards and live secrets', () => {
  for (const [what, draft] of drafts) {
    it(`refuses ${what} that holds a live value, before it is stored or published`, () => {
      const { broker, events, puts, arm } = setup()
      arm()
      const opened = broker.open({ threadId: 't1', chatId: 't1', toolName: 'x', ...draft })
      expect(opened.ok).toBe(false)
      expect(opened.ok ? '' : opened.message).toMatch(/secret/i)
      expect(opened.ok ? '' : opened.message).not.toContain(CANARY)
      expect(puts).toEqual([])
      expect(events).toEqual([])
      expect(broker.pendingEvents('t1')).toEqual([])
    })
  }

  it('opens the same draft in a chat that does not hold the secret', () => {
    const { broker, arm } = setup()
    arm()
    const opened = broker.open({
      threadId: 't2',
      chatId: 't2',
      toolName: 'x',
      detail: 'send',
      plan: { kind: 'peer-send', sessionId: 's2', message: `use ${CANARY}` },
    })
    expect(opened.ok).toBe(true)
  })

  it('masks a card stored before the secret was saved in every recovery', () => {
    const store = memoryApprovalCardStore<AgentWritePlan>()
    const first = setup(store)
    const opened = first.broker.open({
      threadId: 't1',
      chatId: 't1',
      toolName: 'x',
      detail: `reply ${CANARY}`,
      hostWrite: { ...hostWrite, replyText: CANARY },
      plan: { kind: 'secret-request', card: { name: 'B', title: CANARY, instructions: CANARY, ttl: '1h' } },
    })
    expect(opened.ok).toBe(true)
    first.arm()
    expect(JSON.stringify(first.broker.pendingEvents('t1'))).not.toContain(CANARY)

    // After a restart the raw row comes back from the store.
    expect(JSON.stringify(store.loadCards())).toContain(CANARY)
    const restarted = setup(store)
    restarted.arm()
    const recovered = restarted.broker.pendingEvents('t1')
    expect(recovered).toHaveLength(1)
    expect(JSON.stringify(recovered)).not.toContain(CANARY)
    expect(JSON.stringify(recovered)).toContain('[secret API_KEY]')
  })

  it('refuses to approve a card that held the value before it was saved, and still lets it be denied', () => {
    const { broker, events, arm } = setup()
    const opened = broker.open({
      threadId: 't1',
      chatId: 't1',
      toolName: 'x',
      detail: 'send',
      plan: { kind: 'peer-send', sessionId: 's2', message: CANARY },
    })
    if (!opened.ok) throw new Error(opened.message)
    arm()
    const desktop = { mayApproveHostWrite: true, label: 'the desktop' }
    expect(broker.respond('t1', opened.requestId, 'approve', {}, desktop)).toEqual({
      ok: false,
      message: SECRET_IN_CARD_APPROVAL_REFUSAL,
    })
    expect(broker.respond('t1', opened.requestId, 'deny', {}, desktop)).toEqual({ ok: true })
    expect(events.at(-1)).toMatchObject({ type: 'request.closed', decision: 'deny' })
  })
})

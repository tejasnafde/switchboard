import { describe, expect, it, vi } from 'vitest'
import { checkSecretRequestArgs, secretSavedText } from '../../src/shared/agent-secret-request'
import { SecretRequestLimiter, buildSecretMcpTools } from '../../src/main/mcp/secret-tools'
import { AgentApprovalBroker, type AgentApprovalCard, type AgentWritePlan } from '../../src/main/mcp/agent-approvals'
import { AGENT_CARD_MAX_AGE_MS, type ApprovalCardStore } from '../../src/shared/agent-approval-cards'
import type { RuntimeEvent, RuntimeMode } from '../../src/shared/provider-events'

const ARGS = { name: 'TAILSCALE_AUTHKEY', title: 'Tailscale auth key', instructions: 'Make a key in the admin page.' }

describe('checkSecretRequestArgs', () => {
  it('accepts the fields and defaults ttl to 24h', () => {
    expect(checkSecretRequestArgs(ARGS)).toEqual({ ok: true, card: { ...ARGS, ttl: '24h' } })
  })

  it.each([
    [{ ...ARGS, scope: 'turn' }, /Unknown field scope/],
    [{ ...ARGS, name: 'lower' }, /name must match/],
    [{ ...ARGS, name: 'A' }, /name must match/],
    [{ ...ARGS, title: '' }, /title/],
    [{ ...ARGS, title: 'two\nlines' }, /title/],
    [{ ...ARGS, title: 'x'.repeat(81) }, /title/],
    [{ ...ARGS, instructions: 'x'.repeat(1501) }, /instructions/],
    [{ ...ARGS, ttl: '48h' }, /ttl must be one of/],
    [{ ...ARGS, title: 'Tailscale\u202ekey' }, /title/],
    [{ ...ARGS, title: 'Tail\u0007scale' }, /title/],
    [{ ...ARGS, title: 'Tail\tscale' }, /title/],
    [{ ...ARGS, title: 'Tail\u0085scale' }, /title/],
    [{ ...ARGS, instructions: 'Open\u2066 the page' }, /instructions/],
    [{ ...ARGS, instructions: 'Open\u200f the page' }, /instructions/],
    [{ ...ARGS, instructions: 'Open\u001b[31m the page' }, /instructions/],
    [{ ...ARGS, instructions: 'Open\r the page' }, /instructions/],
  ])('refuses %j', (args, message) => {
    const result = checkSecretRequestArgs(args)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(message)
  })

  it('allows new lines and tabs in the instructions', () => {
    expect(checkSecretRequestArgs({ ...ARGS, instructions: 'Step 1:\n\tOpen the admin page.' }).ok).toBe(true)
  })

  it('names the path and the env var in the saved text, and the plan mode note', () => {
    const text = secretSavedText({ name: 'K_EY', file: '/s/d/K_EY', expiresAt: 0, planMode: true })
    expect(text).toContain('/s/d/K_EY')
    expect(text).toContain('$SWITCHBOARD_SECRETS_DIR/K_EY')
    expect(text).toContain('$env:SWITCHBOARD_SECRETS_DIR/K_EY')
    expect(text).toContain('plan mode')
  })
})

function setup(
  mode: RuntimeMode = 'sandbox',
  child = false,
  store?: ApprovalCardStore<AgentWritePlan>,
  archived = false,
) {
  const events: RuntimeEvent[] = []
  let now = 0
  let clock = Date.now()
  const broker = new AgentApprovalBroker({ publish: (e) => events.push(e), now: () => clock, store })
  const limiter = new SecretRequestLimiter(() => now)
  const [tool] = buildSecretMcpTools({
    threadId: 'chat',
    chatId: 'chat',
    runtimeMode: () => mode,
    isOpenChild: () => child,
    archived: () => archived,
    approvals: broker,
    limiter,
  })
  const call = (args: Record<string, unknown> = ARGS) => tool.call(args)
  return {
    broker,
    call,
    events,
    tick: (ms: number) => (now += ms),
    age: (ms: number) => (clock += ms),
  }
}

describe('request_secret', () => {
  it('opens an sbsec_ card and returns at once', async () => {
    const s = setup()
    const result = await s.call()
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toMatch(/Asked the user for TAILSCALE_AUTHKEY \(card sbsec_/)
    expect(s.events[0]).toMatchObject({ type: 'request.opened', secretRequest: { name: 'TAILSCALE_AUTHKEY' } })
  })

  it('refuses plan mode, an open child, and bad arguments without opening a card', async () => {
    expect((await setup('plan').call()).content[0].text).toMatch(/plan mode/)
    expect((await setup('sandbox', true).call()).isError).toBe(true)
    expect((await setup('sandbox', false, undefined, true).call()).content[0].text).toMatch(/archived/)
    const s = setup()
    expect((await s.call({ ...ARGS, extra: 1 })).isError).toBe(true)
    expect(s.events).toEqual([])
  })

  it('caps open cards at 3 and requests at 5 per 10 minutes', async () => {
    const s = setup()
    for (let i = 0; i < 3; i++) expect((await s.call()).isError).toBeFalsy()
    expect((await s.call()).content[0].text).toMatch(/3 open secret requests/)
    for (const e of s.events) if (e.type === 'request.opened') s.broker.withdraw('chat', e.requestId)
    for (let i = 0; i < 2; i++) expect((await s.call()).isError).toBeFalsy()
    expect((await s.call()).content[0].text).toMatch(/5 secrets in the last 10 minutes/)
    s.tick(10 * 60_000 + 1)
    expect((await s.call()).isError).toBeFalsy()
  })

  it('does not count cards past the 7-day cap toward the open card cap', async () => {
    const s = setup()
    for (let i = 0; i < 3; i++) expect((await s.call()).isError).toBeFalsy()
    s.age(AGENT_CARD_MAX_AGE_MS)
    s.tick(10 * 60_000 + 1)
    expect(s.broker.openSecretCards('chat')).toBe(0)
    expect((await s.call()).isError).toBeFalsy()
  })
})

describe('the broker and secret cards', () => {
  it('saves only through saveSecret, keeps a card open when the save throws, and skips it on a Stop', async () => {
    const s = setup()
    await s.call()
    const id = (s.events[0] as { requestId: string }).requestId
    expect(s.broker.respond('chat', id, 'approve', {}, { mayApproveHostWrite: true, label: 't' }).ok).toBe(false)
    expect(() =>
      s.broker.saveSecret('chat', id, () => {
        throw new Error('disk')
      }),
    ).toThrow()
    s.broker.closeChat('chat')
    expect(s.broker.pendingEvents('chat')).toHaveLength(1)
    expect(s.broker.saveSecret('chat', id, () => {})).toEqual({ ok: true })
    expect(s.broker.pendingEvents('chat')).toEqual([])
    expect(s.broker.saveSecret('chat', id, () => {})).toMatchObject({ ok: false })
  })
})

describe('saveSecret when the card store fails', () => {
  function failingStore() {
    const rows = new Map<string, AgentApprovalCard>()
    const store = {
      failRemove: false,
      failPut: false,
      loadCards: () => [...rows.values()],
      putCard: (card: AgentApprovalCard) => {
        if (store.failPut) throw new Error('put failed')
        rows.set(card.requestId, card)
      },
      removeCard: (id: string) => {
        if (store.failRemove) throw new Error('remove failed')
        rows.delete(id)
      },
      rows,
    }
    return store
  }

  it('writes nothing and keeps the card open in memory and in the store when the close fails', async () => {
    const store = failingStore()
    const s = setup('sandbox', false, store)
    await s.call()
    const id = (s.events[0] as { requestId: string }).requestId
    store.failRemove = true
    const save = vi.fn()
    expect(() => s.broker.saveSecret('chat', id, save)).toThrow(/remove failed/)
    expect(save).not.toHaveBeenCalled()
    expect(s.broker.pendingEvents('chat')).toHaveLength(1)
    expect(store.rows.has(id)).toBe(true)
    store.failRemove = false
    expect(s.broker.saveSecret('chat', id, save)).toEqual({ ok: true })
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.rows.has(id)).toBe(false)
    expect(s.events.filter((e) => e.type === 'request.closed')).toHaveLength(1)
  })

  it('puts the card back in the store when the save throws', async () => {
    const store = failingStore()
    const s = setup('sandbox', false, store)
    await s.call()
    const id = (s.events[0] as { requestId: string }).requestId
    expect(() =>
      s.broker.saveSecret('chat', id, () => {
        throw new Error('disk')
      }),
    ).toThrow(/disk/)
    expect(store.rows.has(id)).toBe(true)
    expect(s.broker.pendingEvents('chat')).toHaveLength(1)
    expect(s.events.filter((e) => e.type === 'request.closed')).toEqual([])
  })

  it('keeps the card open in memory when the save and the put back both throw', async () => {
    const store = failingStore()
    const s = setup('sandbox', false, store)
    await s.call()
    const id = (s.events[0] as { requestId: string }).requestId
    store.failPut = true
    expect(() =>
      s.broker.saveSecret('chat', id, () => {
        throw new Error('disk')
      }),
    ).toThrow(/disk/)
    expect(store.rows.has(id)).toBe(false)
    expect(s.broker.pendingEvents('chat')).toHaveLength(1)
    expect(s.events.filter((e) => e.type === 'request.closed')).toEqual([])
    store.failPut = false
    expect(s.broker.saveSecret('chat', id, () => {})).toEqual({ ok: true })
  })
})

describe('push for a secret request', () => {
  it('never carries the title or the instructions', async () => {
    const { pushForEvent } = await import('../../src/shared/push-policy')
    const s = setup()
    await s.call()
    const push = pushForEvent(s.events[0], { title: 'My chat' })
    expect(push).toMatchObject({ title: 'My chat', body: 'An agent asks for a secret' })
    expect(JSON.stringify(push)).not.toMatch(/Tailscale|admin page/)
  })
})

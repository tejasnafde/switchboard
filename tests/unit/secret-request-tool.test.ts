import { describe, expect, it } from 'vitest'
import { checkSecretRequestArgs, secretSavedText } from '../../src/shared/agent-secret-request'
import { SecretRequestLimiter, buildSecretMcpTools } from '../../src/main/mcp/secret-tools'
import { AgentApprovalBroker } from '../../src/main/mcp/agent-approvals'
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
  ])('refuses %j', (args, message) => {
    const result = checkSecretRequestArgs(args)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(message)
  })

  it('names the path and the env var in the saved text, and the plan mode note', () => {
    const text = secretSavedText({ name: 'K_EY', file: '/s/d/K_EY', expiresAt: 0, planMode: true })
    expect(text).toContain('/s/d/K_EY')
    expect(text).toContain('$SWITCHBOARD_SECRETS_DIR/K_EY')
    expect(text).toContain('plan mode')
  })
})

function setup(mode: RuntimeMode = 'sandbox', child = false) {
  const events: RuntimeEvent[] = []
  let now = 0
  const broker = new AgentApprovalBroker({ publish: (e) => events.push(e) })
  const limiter = new SecretRequestLimiter(() => now)
  const [tool] = buildSecretMcpTools({
    threadId: 'chat',
    chatId: 'chat',
    runtimeMode: () => mode,
    isOpenChild: () => child,
    approvals: broker,
    limiter,
  })
  const call = (args: Record<string, unknown> = ARGS) => tool.call(args)
  return { broker, call, events, tick: (ms: number) => (now += ms) }
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

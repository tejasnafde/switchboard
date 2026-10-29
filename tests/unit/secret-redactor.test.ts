/** The saved-secret matcher and the stream carry that masks runtime events. */
import { describe, expect, it } from 'vitest'
import { SecretRedactor, secretMask } from '../../src/main/secrets/secret-redactor'
import { RuntimeEventRedaction } from '../../src/main/secrets/runtime-event-redaction'
import type { RuntimeContentEvent, RuntimeEvent } from '../../src/shared/provider-events'

const VALUE = 'tskey-auth-k1+/x=9'
const MASK = secretMask('TAILSCALE_AUTHKEY')

function armed(value = VALUE) {
  const r = new SecretRedactor()
  r.add('chat', 'sec_1', 'TAILSCALE_AUTHKEY', Buffer.from(value))
  return r
}

const delta = (text: string, messageId = 'm1'): RuntimeContentEvent => ({
  type: 'content',
  threadId: 'chat',
  messageId,
  text,
  append: true,
  streamKind: 'assistant',
})

/** The text a client folds from the published content events. */
function folded(events: RuntimeEvent[]): string {
  return events
    .filter((e): e is RuntimeContentEvent => e.type === 'content')
    .map((e) => e.text)
    .join('')
}

describe('SecretRedactor', () => {
  it('masks the exact value, its base64 and base64url forms, and its URL-encoded form', () => {
    const r = armed()
    const b64 = Buffer.from(VALUE).toString('base64')
    const b64url = Buffer.from(VALUE).toString('base64url')
    const url = encodeURIComponent(VALUE)
    expect(r.redactText('chat', `a ${VALUE} b`)).toBe(`a ${MASK} b`)
    expect(r.redactText('chat', `Authorization: Basic ${b64}`)).toBe(`Authorization: Basic ${MASK}`)
    expect(r.redactText('chat', `t=${b64url}`)).toBe(`t=${MASK}`)
    expect(r.redactText('chat', `?key=${url}&x=1`)).toBe(`?key=${MASK}&x=1`)
    expect(r.redactText('chat', `${VALUE}${VALUE}`)).toBe(`${MASK}${MASK}`)
  })

  it('keeps multi-byte text around a match intact', () => {
    const r = armed('pässwörd-ünïcode')
    expect(r.redactText('chat', 'é pässwörd-ünïcode ✓')).toBe(`é ${MASK} ✓`)
  })

  it('returns null and the same object when nothing matched', () => {
    const r = armed()
    expect(r.redactText('chat', 'nothing here')).toBeNull()
    const event = { type: 'tool.completed', threadId: 'chat', toolId: 't', output: 'ok' }
    expect(r.redactDeep('chat', event)).toEqual({ value: event, hit: false })
    expect(r.redactDeep('chat', event).value).toBe(event)
  })

  it('masks strings deep in objects and arrays without touching the input', () => {
    const r = armed()
    const input = { command: ['curl', '-H', `X-Key: ${VALUE}`], nested: { env: { K: VALUE } }, n: 3 }
    const { value, hit } = r.redactDeep('chat', input)
    expect(hit).toBe(true)
    expect(value).toEqual({ command: ['curl', '-H', `X-Key: ${MASK}`], nested: { env: { K: MASK } }, n: 3 })
    expect(input.nested.env.K).toBe(VALUE)
  })

  it('masks padded base64 and lower-case percent escapes as one whole mask', () => {
    const r = armed('abcdefgh/x')
    const padded = Buffer.from('abcdefgh/x').toString('base64')
    expect(padded.endsWith('=')).toBe(true)
    expect(r.redactText('chat', `b=${padded};`)).toBe(`b=${MASK};`)
    expect(r.redactText('chat', '?k=abcdefgh%2fx&x')).toBe(`?k=${MASK}&x`)
    expect(r.redactText('chat', '?k=abcdefgh%2Fx&x')).toBe(`?k=${MASK}&x`)
  })

  it('masks object keys, keeps two keys that mask alike, and reports the hit', () => {
    const r = armed()
    const input = { [VALUE]: 1, [Buffer.from(VALUE).toString('base64url')]: 2, ok: 3 }
    const { value, hit } = r.redactDeep('chat', input)
    expect(hit).toBe(true)
    expect(value).toEqual({ [MASK]: 1, [`${MASK} (2)`]: 2, ok: 3 })
    expect(JSON.stringify(value)).not.toContain(VALUE)
    const plain = { a: { b: 1 } }
    expect(r.redactDeep('chat', plain).value).toBe(plain)
  })

  it('masks the whole span when two values overlap, leaving no tail of either', () => {
    const r = new SecretRedactor()
    r.add('chat', 'sec_a', 'KEY_A', Buffer.from('abcdefgh12'))
    r.add('chat', 'sec_b', 'KEY_B', Buffer.from('gh12345678'))
    expect(r.redactText('chat', 'x abcdefgh12345678 y')).toBe(`x ${secretMask('KEY_A')} y`)
  })

  it('matches the values of every chat in a scope (a fork and its parents)', () => {
    const r = armed()
    expect(r.redactText(['fork', 'chat'], VALUE)).toBe(MASK)
    expect(r.armed(['fork'])).toBe(false)
  })

  it('matches only in its own chat', () => {
    const r = armed()
    expect(r.redactText('other', VALUE)).toBeNull()
  })

  it('does not match a value under 8 characters', () => {
    const r = new SecretRedactor()
    expect(r.add('chat', 'sec_1', 'PIN', Buffer.from('1234567'))).toBe(false)
    expect(r.any()).toBe(false)
    expect(r.redactText('chat', 'pin 1234567')).toBeNull()
  })

  it('copies the value and zero-fills its own copies on drop', () => {
    const r = new SecretRedactor()
    const given = Buffer.from(VALUE)
    r.add('chat', 'sec_1', 'TAILSCALE_AUTHKEY', given)
    given.fill(0)
    expect(r.redactText('chat', VALUE)).toBe(MASK)
    const patterns = (r as unknown as { chats: Map<string, Map<string, { patterns: Buffer[] }>> }).chats
      .get('chat')!
      .get('sec_1')!.patterns
    r.drop('sec_1')
    expect(patterns.every((p) => p.every((byte) => byte === 0))).toBe(true)
    expect(r.armed('chat')).toBe(false)
    expect(r.redactText('chat', VALUE)).toBeNull()
  })

  it('drops a whole chat', () => {
    const r = armed()
    r.add('chat', 'sec_2', 'OTHER_KEY', Buffer.from('another-long-value'))
    r.dropChat('chat')
    expect(r.any()).toBe(false)
  })
})

describe('RuntimeEventRedaction', () => {
  const redaction = (r = armed()) => new RuntimeEventRedaction(r, (id) => id)

  it('passes every event through unchanged when no secret is live (the flag off)', () => {
    const red = redaction(new SecretRedactor())
    const events: RuntimeEvent[] = [
      delta(`see ${VALUE}`),
      { type: 'tool.completed', threadId: 'chat', toolId: 't', output: VALUE },
      { type: 'turn.completed', threadId: 'chat' },
    ]
    for (const event of events) expect(red.apply(event)).toEqual({ events: [event], masked: null })
  })

  it('masks a value split across deltas and flushes the held tail at the turn end', () => {
    const red = redaction()
    const out: RuntimeEvent[] = []
    let masked = false
    for (const part of ['The key is ', VALUE.slice(0, 5), VALUE.slice(5, 11), `${VALUE.slice(11)} and done.`]) {
      const result = red.apply(delta(part))
      out.push(...result.events)
      if (result.masked) masked = true
    }
    out.push(...red.apply({ type: 'turn.completed', threadId: 'chat' }).events)
    expect(masked).toBe(true)
    expect(folded(out)).toBe(`The key is ${MASK} and done.`)
    expect(JSON.stringify(out)).not.toContain(VALUE.slice(0, 11))
    expect(out.at(-1)).toEqual({ type: 'turn.completed', threadId: 'chat' })
  })

  it('keeps the carry across a notice row, so a second value split after the first hit is masked', () => {
    const red = redaction()
    const out: RuntimeEvent[] = []
    // The first hit and the start of a second value arrive in one delta.
    out.push(...red.apply(delta(`first ${VALUE} then ${VALUE.slice(0, 9)}`)).events)
    // The registry posts its masked-secret row here, on the same thread.
    out.push(
      ...red.apply({
        type: 'approval.result',
        threadId: 'chat',
        messageId: 'n',
        requestId: 'n',
        content: 'notice',
        at: 0,
      }).events,
    )
    out.push(...red.apply({ type: 'status', threadId: 'chat', status: 'running' }).events)
    out.push(...red.apply(delta(`${VALUE.slice(9)} end`)).events)
    out.push(...red.apply({ type: 'turn.completed', threadId: 'chat' }).events)
    expect(folded(out)).toBe(`first ${MASK} then ${MASK} end`)
    expect(JSON.stringify(out)).not.toContain(VALUE.slice(0, 9))
  })

  it('keeps the carry across a message the user queued', () => {
    const red = redaction()
    const out: RuntimeEvent[] = []
    out.push(...red.apply(delta(`key ${VALUE.slice(0, 9)}`)).events)
    out.push(...red.apply({ type: 'turn.queued', threadId: 'chat', messageId: 'q1', text: 'later' }).events)
    out.push(...red.apply(delta(`${VALUE.slice(9)} end`)).events)
    out.push(...red.apply({ type: 'turn.completed', threadId: 'chat' }).events)
    expect(folded(out)).toBe(`key ${MASK} end`)
    expect(JSON.stringify(out)).not.toContain(VALUE.slice(0, 9))
  })

  it('flushes the held tail before another message or a tool call', () => {
    const red = redaction()
    const out = [
      ...red.apply(delta('first message text')).events,
      ...red.apply({ type: 'tool.started', threadId: 'chat', toolId: 't', toolName: 'Bash', input: {} }).events,
    ]
    expect(folded(out)).toBe('first message text')
    expect(out.at(-1)?.type).toBe('tool.started')
  })

  it('masks a whole snapshot, tool input and tool output', () => {
    const red = redaction()
    const snapshot = red.apply({ ...delta(`all ${VALUE}`), append: undefined })
    expect(snapshot).toMatchObject({ events: [{ text: `all ${MASK}` }], masked: { where: 'text' } })
    const started = red.apply({
      type: 'tool.started',
      threadId: 'chat',
      toolId: 't',
      toolName: 'Bash',
      input: { command: `echo ${VALUE}` },
    })
    expect(started).toMatchObject({ events: [{ input: { command: `echo ${MASK}` } }], masked: { where: 'tool' } })
    const done = red.apply({ type: 'tool.completed', threadId: 'chat', toolId: 't', output: `${VALUE}\n` })
    expect(done).toMatchObject({ events: [{ output: `${MASK}\n` }], masked: { where: 'tool' } })
  })

  it('masks a changed file, names it, and turns off Accept and Reject for it', () => {
    const red = redaction()
    const { event, masked } = red.mask({
      type: 'file.edited',
      threadId: 'chat',
      turnId: '1',
      fileEditId: 'f',
      repoRoot: '/repo',
      relPath: '.env',
      changeKind: 'modify',
      oldContent: '',
      newContent: `KEY=${VALUE}\n`,
    })
    expect(event).toMatchObject({ newContent: `KEY=${MASK}\n`, noRevert: 'unknown' })
    expect(masked).toEqual({ where: 'diff', path: '.env' })
  })
})

/**
 * Saved-secret masking of the escaped forms ordinary tools print a value in
 * (URL, form, JSON and shell quoting), and of streams that interleave.
 */
import { describe, expect, it } from 'vitest'
import { SecretRedactor, secretMask } from '../../src/main/secrets/secret-redactor'
import { RuntimeEventRedaction } from '../../src/main/secrets/runtime-event-redaction'
import type { RuntimeContentEvent, RuntimeEvent } from '../../src/shared/provider-events'

const CANARY = `sbcanary_8+A/9 x"y\\z'w$q`
const NAME = 'API_TOKEN'
const MASK = secretMask(NAME)

function armed(value = CANARY) {
  const r = new SecretRedactor()
  r.add('chat', 'sec_1', NAME, Buffer.from(value))
  return r
}

/** Percent-encode every UTF-8 byte except letters, digits and `safe`, like Python's urllib.parse.quote. */
function pyQuote(value: string, safe: string): string {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte)
    out +=
      /[A-Za-z0-9_.~-]/.test(char) || safe.includes(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** Every other percent escape in lower case, so the string is in neither one case nor the other. */
function alternateCase(s: string): string {
  let n = 0
  return s.replace(/%[0-9A-F]{2}/g, (escape) => (n++ % 2 === 0 ? escape : escape.toLowerCase()))
}

describe('SecretRedactor escaped forms', () => {
  const forms: Array<[string, string]> = [
    ['Python quote, slash kept', pyQuote(CANARY, '/')],
    ['Python quote_plus', pyQuote(CANARY, '').replace(/%20/g, '+')],
    ['form encoding (URLSearchParams)', new URLSearchParams({ k: CANARY }).toString().slice(2)],
    ['mixed-case percent escapes', alternateCase(encodeURIComponent(CANARY))],
    ['JSON string', JSON.stringify(CANARY)],
    ['JSON with escaped slashes', JSON.stringify(CANARY).replace(/\//g, '\\/')],
    ['JSON \\u escapes', `"${[...CANARY].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`],
    ['shell single quotes', `'${CANARY.replace(/'/g, `'\\''`)}'`],
    ['shell single quotes, double-quote splice', `'${CANARY.replace(/'/g, `'"'"'`)}'`],
    ['shell double quotes', `"${CANARY.replace(/["\\$`]/g, '\\$&')}"`],
  ]
  for (const [label, form] of forms) {
    it(`masks the ${label} form`, () => {
      const masked = armed().redactText('chat', `before ${form} after`)
      expect(masked).not.toBeNull()
      expect(masked).toContain(MASK)
      expect(masked).not.toContain('sbcanary_8')
      expect(masked!.startsWith('before ')).toBe(true)
      expect(masked!.endsWith(' after')).toBe(true)
    })
  }

  it('keeps text next to a match whole, multi-byte text included', () => {
    expect(armed('pässwörd-ünïcode').redactText('chat', `é ${encodeURIComponent('pässwörd-ünïcode')} ✓`)).toBe(
      `é ${secretMask(NAME)} ✓`,
    )
  })

  it('does not mask a near miss', () => {
    expect(armed().redactText('chat', pyQuote('sbcanary_8+A/9 x"y\\z\'w$Q', '/'))).toBeNull()
  })

  it('masks a log line through every chat (redactAnyText)', () => {
    const r = armed()
    r.add('other', 'sec_2', 'OTHER', Buffer.from('sbcanary_other_0123'))
    expect(r.redactAnyText(`a ${CANARY} b sbcanary_other_0123`)).toBe(`a ${MASK} b ${secretMask('OTHER')}`)
  })

  it('holds back only a tail that could grow into a match', () => {
    const r = armed()
    expect(r.holdFrom('chat', 'nothing to hold here')).toBe('nothing to hold here'.length)
    expect(r.holdFrom('chat', 'tail sbcanary_8%2')).toBe('tail '.length)
    expect(r.holdFrom('chat', `json "sbcanary_8+A/9 x\\`)).toBe('json "'.length)
  })
})

const canary = 'sbcanary_3_interleaved_0123456789'

const delta = (
  text: string,
  messageId: string,
  streamKind: RuntimeContentEvent['streamKind'] = 'assistant',
  parentToolCallId?: string,
): RuntimeContentEvent => ({
  type: 'content',
  threadId: 'chat',
  messageId,
  text,
  append: true,
  streamKind,
  ...(parentToolCallId ? { parentToolCallId } : {}),
})

/** The text a client folds for one message. */
function messageText(events: RuntimeEvent[], messageId: string): string {
  return events
    .filter((e): e is RuntimeContentEvent => e.type === 'content' && e.messageId === messageId)
    .map((e) => e.text)
    .join('')
}

describe('RuntimeEventRedaction interleaved streams', () => {
  const redaction = () => new RuntimeEventRedaction(armed(canary), (id) => id)

  it('masks a value split around a reasoning message', () => {
    const red = redaction()
    const out: RuntimeEvent[] = []
    for (const event of [
      delta(`key ${canary.slice(0, 9)}`, 'm'),
      delta('working', 'r', 'reasoning'),
      delta(`${canary.slice(9)} done`, 'm'),
      { type: 'turn.completed', threadId: 'chat' } as const,
    ])
      out.push(...red.apply(event).events)
    expect(messageText(out, 'm')).toBe(`key ${MASK} done`)
    expect(messageText(out, 'r')).toBe('working')
    expect(JSON.stringify(out)).not.toContain(canary.slice(0, 9))
  })

  it('masks a value split around a tool call and its output', () => {
    const red = redaction()
    const out: RuntimeEvent[] = []
    for (const event of [
      delta(`key ${canary.slice(0, 12)}`, 'm'),
      { type: 'tool.started', threadId: 'chat', toolId: 't', toolName: 'Bash', input: { command: 'ls' } } as const,
      { type: 'tool.completed', threadId: 'chat', toolId: 't', output: 'a.txt' } as const,
      delta('sub agent text', 's', 'assistant', 't'),
      delta(`${canary.slice(12)} done`, 'm'),
      { type: 'turn.completed', threadId: 'chat' } as const,
    ])
      out.push(...red.apply(event).events)
    expect(messageText(out, 'm')).toBe(`key ${MASK} done`)
    expect(messageText(out, 's')).toBe('sub agent text')
    expect(JSON.stringify(out)).not.toContain(canary.slice(0, 12))
  })

  it('sends a message with no possible match without holding any of it', () => {
    const red = redaction()
    expect(messageText(red.apply(delta('plain wording', 'm')).events, 'm')).toBe('plain wording')
  })

  it('masks a value split around another message of the same kind', () => {
    const red = redaction()
    const out: RuntimeEvent[] = []
    for (const event of [
      delta(`key ${canary.slice(0, 9)}`, 'm1'),
      delta('other message', 'm2'),
      delta(`${canary.slice(9)} done`, 'm1'),
      { type: 'turn.completed', threadId: 'chat' } as const,
    ])
      out.push(...red.apply(event).events)
    expect(messageText(out, 'm1')).toBe(`key ${MASK} done`)
    expect(messageText(out, 'm2')).toBe('other message')
    expect(JSON.stringify(out)).not.toContain(canary.slice(0, 9))
  })

  it('sends every held tail at the turn end, before the turn end', () => {
    const red = redaction()
    const out: RuntimeEvent[] = [
      ...red.apply(delta('first ends with sb', 'm1')).events,
      ...red.apply(delta('second sbc', 'm2')).events,
    ]
    expect(messageText(out, 'm1')).toBe('first ends with ')
    expect(messageText(out, 'm2')).toBe('second ')
    out.push(...red.apply({ type: 'turn.completed', threadId: 'chat' }).events)
    expect(messageText(out, 'm1')).toBe('first ends with sb')
    expect(messageText(out, 'm2')).toBe('second sbc')
    expect(out.at(-1)?.type).toBe('turn.completed')
  })
})

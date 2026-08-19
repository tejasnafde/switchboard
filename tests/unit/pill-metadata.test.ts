import { describe, expect, it } from 'vitest'
import { parsePersistedPillsMeta } from '../../src/main/provider/pill-metadata'

describe('parsePersistedPillsMeta', () => {
  it('keeps only bounded entries that match the pill wire contract', () => {
    expect(parsePersistedPillsMeta(JSON.stringify({
      valid_file: { label: 'src/App.tsx', kind: 'file' },
      validTerminal: { label: 'Terminal 1', kind: 'terminal' },
      'valid-chat': { label: 'Earlier message', kind: 'chat-message' },
      'bad id': { label: 'Hidden', kind: 'file' },
      badKind: { label: 'Hidden', kind: 'command' },
      blankLabel: { label: '   ', kind: 'file' },
      objectLabel: { label: { secret: true }, kind: 'file' },
    }))).toEqual({
      valid_file: { label: 'src/App.tsx', kind: 'file' },
      validTerminal: { label: 'Terminal 1', kind: 'terminal' },
      'valid-chat': { label: 'Earlier message', kind: 'chat-message' },
    })
  })

  it.each([
    undefined,
    '',
    '{broken',
    'null',
    '[]',
    JSON.stringify({ nope: { label: 'Nope', kind: 'unknown' } }),
  ])('drops malformed or empty metadata: %s', (raw) => {
    expect(parsePersistedPillsMeta(raw)).toBeUndefined()
  })

  it('caps the metadata sent over the live event boundary', () => {
    const raw = JSON.stringify(Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `pill_${index}`,
        { label: `Pill ${index}`, kind: 'file' },
      ]),
    ))

    expect(Object.keys(parsePersistedPillsMeta(raw) ?? {})).toHaveLength(32)
  })
})

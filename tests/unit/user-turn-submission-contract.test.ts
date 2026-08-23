import { describe, expect, it } from 'vitest'
import * as providerEvents from '../../src/shared/provider-events'

const contract = providerEvents as typeof providerEvents & {
  validateUserTurnSubmission(input: unknown): unknown
  canonicalUserTurnSubmission(input: unknown): string
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    threadId: 'thread-1',
    origin: 'desktop-origin-1',
    providerText: 'expanded provider text',
    displayBody: '[[pill:file-1]] explain this',
    pillsMeta: {
      'file-1': { label: 'src/main.ts', kind: 'file' },
    },
    runtimeMode: 'sandbox',
    images: Array.from({ length: 7 }, (_, index) => ({
      url: `data:image/png;base64,${'A'.repeat(32 + index)}`,
      mimeType: 'image/png',
      name: `screenshot-${index + 1}.png`,
    })),
    handoff: {
      expectedFrom: 'codex',
      markerId: 'handoff-1',
      markerText: '[[sb:context-handoff]] Codex → Claude',
    },
    autoTitleText: 'explain these screenshots',
    ...overrides,
  }
}

describe('atomic user-turn envelope', () => {
  it('accepts seven valid images below the existing byte budget', () => {
    expect(() => contract.validateUserTurnSubmission(submission())).not.toThrow()
  })

  it('rejects aggregate image data above 3 MiB without adding a count cap', () => {
    const images = Array.from({ length: 7 }, (_, index) => ({
      url: `data:image/png;base64,${'A'.repeat(450_000 + index)}`,
      mimeType: 'image/png',
      name: `large-${index}.png`,
    }))

    expect(() => contract.validateUserTurnSubmission(submission({ images }))).toThrow(
      'Images exceed the 3 MiB synchronization limit',
    )
  })

  it('hashes every committed provider and presentation field', () => {
    const base = contract.canonicalUserTurnSubmission(submission())
    expect(contract.canonicalUserTurnSubmission(submission())).toBe(base)
    expect(contract.canonicalUserTurnSubmission(submission({ providerText: 'changed' }))).not.toBe(base)
    expect(contract.canonicalUserTurnSubmission(submission({ displayBody: 'changed' }))).not.toBe(base)
    expect(contract.canonicalUserTurnSubmission(submission({ pillsMeta: {} }))).not.toBe(base)
    expect(contract.canonicalUserTurnSubmission(submission({ runtimeMode: 'plan' }))).not.toBe(base)
    expect(contract.canonicalUserTurnSubmission(submission({ autoTitleText: 'changed' }))).not.toBe(base)
    expect(contract.canonicalUserTurnSubmission(submission({ handoff: undefined }))).not.toBe(base)
    const changedImages = submission().images as Array<Record<string, unknown>>
    expect(contract.canonicalUserTurnSubmission(submission({
      images: changedImages.map((image, index) => index === 0 ? { ...image, name: 'changed.png' } : image),
    }))).not.toBe(base)
  })

  it('rejects malformed presentation and handoff metadata before mutation', () => {
    expect(() => contract.validateUserTurnSubmission(submission({
      pillsMeta: { private: { label: 'secret', kind: 'unknown' } },
    }))).toThrow('pill metadata')
    expect(() => contract.validateUserTurnSubmission(submission({
      handoff: { expectedFrom: '', markerId: '', markerText: '' },
    }))).toThrow('handoff metadata')
  })
})

/**
 * Tests for `sortTemplatesByRecency` — picker dropdown sort key.
 *
 * Recency desc, then `default` first, then alphabetical for the
 * remaining no-recorded-use bucket.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { sortTemplatesByRecency, recordTemplateUsage } from '../../src/renderer/services/templateUsage'

// Minimal localStorage shim so the helper runs under Node.
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
  key() { return null }
  get length() { return this.map.size }
}

beforeEach(() => {
  ;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()
})

describe('sortTemplatesByRecency', () => {
  it('returns alphabetical with `default` pinned to top when no recorded use', () => {
    const out = sortTemplatesByRecency(['zebra', 'apple', 'default', 'mango'], '/proj')
    expect(out).toEqual(['default', 'apple', 'mango', 'zebra'])
  })

  it('sorts most-recently-used first', async () => {
    recordTemplateUsage('/proj', 'apple')
    await new Promise((r) => setTimeout(r, 2))  // ensure distinct ms
    recordTemplateUsage('/proj', 'zebra')  // most recent
    const out = sortTemplatesByRecency(['default', 'apple', 'zebra', 'mango'], '/proj')
    expect(out.slice(0, 2)).toEqual(['zebra', 'apple'])
    // Unused names trail; `default` comes before `mango` in that bucket.
    expect(out.slice(2)).toEqual(['default', 'mango'])
  })

  it('scopes recency per-project', () => {
    recordTemplateUsage('/proj-a', 'staging')
    const out = sortTemplatesByRecency(['default', 'staging'], '/proj-b')
    // /proj-b has no recorded use — alphabetical with default first.
    expect(out).toEqual(['default', 'staging'])
  })

  it('does not mutate the input array', () => {
    const input = ['zebra', 'apple']
    const out = sortTemplatesByRecency(input, '/proj')
    expect(input).toEqual(['zebra', 'apple'])
    expect(out).not.toBe(input)
  })
})

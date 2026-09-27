/**
 * Per pull request cache keyed by its key and the host's updated time. An
 * entry is good for as long as the PR's `updated_on` / `updatedAt` has not
 * moved, so a refresh re-reads only what changed. Capped, oldest dropped.
 *
 * An entry can also carry an expiry: commit statuses do not bump a PR's
 * updated time, so a value holding running checks is re-read after `maxAgeMs`
 * even when the PR itself is unchanged.
 */

interface Entry<T> {
  version: string
  value: T
  storedAt: number
  maxAgeMs: number | null
}

export class VersionedCache<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(
    private readonly capacity = 500,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, version: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry || entry.version !== version) return undefined
    if (entry.maxAgeMs !== null && this.now() - entry.storedAt >= entry.maxAgeMs) return undefined
    // Re-insert so the map's order is least recently used first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, version: string, value: T, opts: { maxAgeMs?: number } = {}): void {
    this.entries.delete(key)
    this.entries.set(key, { version, value, storedAt: this.now(), maxAgeMs: opts.maxAgeMs ?? null })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

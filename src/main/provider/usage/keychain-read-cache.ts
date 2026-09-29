/**
 * Shares keychain reads by SERVICE name, not by instance.
 *
 * Every read of an item `security` has no lasting access to is a macOS
 * password prompt, and two instances can resolve to the same service (both
 * unset, or one dir with and without a trailing slash). So:
 * - a read in flight is joined by every caller asking for that service;
 * - a result is kept for a window (`ttlMs`), shared by every instance;
 * - an item that exists but holds no credential is kept for the process,
 *   since reading it again prompts again and cannot give a different answer
 *   until Claude Code writes it;
 * - a blocked read (a prompt left open until the timeout) is never kept.
 *
 * `fresh` (the user's Usage refresh, or a re-read after a token refresh)
 * skips what is kept but still waits for a read in flight rather than
 * running a second one next to it. `forgetOwner` drops what an instance
 * read, for when the instance is edited or deleted.
 *
 * Pure apart from the injected loader and clock.
 */

export type ServiceOutcome<T> =
  | { kind: 'found'; value: T }
  | { kind: 'no-payload' }
  | { kind: 'absent' }
  | { kind: 'blocked' }

export interface KeychainReadCache<T> {
  read(
    service: string,
    load: () => Promise<ServiceOutcome<T>>,
    opts?: { fresh?: boolean; owner?: string },
  ): Promise<ServiceOutcome<T>>
  forgetOwner(owner: string): void
  clear(): void
}

interface Kept<T> {
  outcome: ServiceOutcome<T>
  /** Epoch ms; Infinity for a result kept for the process. */
  expiresAtMs: number
}

export function createKeychainReadCache<T>(opts: { ttlMs: number; now?: () => number }): KeychainReadCache<T> {
  const now = opts.now ?? Date.now
  const kept = new Map<string, Kept<T>>()
  const inFlight = new Map<string, Promise<ServiceOutcome<T>>>()
  const owners = new Map<string, Set<string>>()

  const keptFor = (service: string): Kept<T> | null => {
    const entry = kept.get(service)
    if (!entry) return null
    if (now() < entry.expiresAtMs) return entry
    kept.delete(service)
    return null
  }

  const start = (service: string, load: () => Promise<ServiceOutcome<T>>): Promise<ServiceOutcome<T>> => {
    const task = load()
      .then((outcome) => {
        if (outcome.kind === 'no-payload') kept.set(service, { outcome, expiresAtMs: Infinity })
        else if (outcome.kind !== 'blocked') kept.set(service, { outcome, expiresAtMs: now() + opts.ttlMs })
        return outcome
      })
      .finally(() => {
        if (inFlight.get(service) === task) inFlight.delete(service)
      })
    inFlight.set(service, task)
    return task
  }

  return {
    async read(service, load, { fresh = false, owner } = {}) {
      if (owner !== undefined) {
        const set = owners.get(owner) ?? new Set<string>()
        set.add(service)
        owners.set(owner, set)
      }
      if (!fresh) {
        const entry = keptFor(service)
        if (entry) return entry.outcome
      }
      const running = inFlight.get(service)
      if (running && !fresh) return running
      if (running) {
        // A fresh read must not return one that began before, say, a token
        // refresh, and must not run beside it either (two prompts).
        await Promise.allSettled([running])
        const joined = inFlight.get(service)
        if (joined) return joined
      }
      return start(service, load)
    },

    forgetOwner(owner) {
      for (const service of owners.get(owner) ?? []) kept.delete(service)
      owners.delete(owner)
    },

    clear() {
      kept.clear()
      owners.clear()
    },
  }
}

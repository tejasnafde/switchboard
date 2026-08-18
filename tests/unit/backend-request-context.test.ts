import { describe, expect, it } from 'vitest'
import {
  currentBackendRequestContext,
  hashClientScope,
  withBackendRequestContext,
} from '../../src/main/backend/request-context'

describe('backend request context', () => {
  it('keeps concurrent remote client scopes isolated across awaits', async () => {
    const observed: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    const first = withBackendRequestContext({ clientScope: 'scope-a' }, async () => {
      await gate
      observed.push(currentBackendRequestContext()?.clientScope ?? 'missing')
    })
    const second = withBackendRequestContext({ clientScope: 'scope-b' }, async () => {
      observed.push(currentBackendRequestContext()?.clientScope ?? 'missing')
      release()
    })
    await Promise.all([first, second])

    expect(observed.sort()).toEqual(['scope-a', 'scope-b'])
    expect(currentBackendRequestContext()).toBeUndefined()
  })

  it('stores only a one-way digest of a credential-derived scope', () => {
    const scope = hashClientScope('device-session', 'raw-secret-token')
    expect(scope).toMatch(/^device-session:[a-f0-9]{64}$/)
    expect(scope).not.toContain('raw-secret-token')
  })

  it('documents legacy shared-token scope while device sessions remain distinct', () => {
    // Legacy WS/TCP has no per-device identifier. Two clients presenting the
    // same static token must therefore share one origin namespace.
    expect(hashClientScope('legacy-ws-token', 'shared')).toBe(
      hashClientScope('legacy-ws-token', 'shared'),
    )
    expect(hashClientScope('device-session', 'device-a')).not.toBe(
      hashClientScope('device-session', 'device-b'),
    )
  })
})

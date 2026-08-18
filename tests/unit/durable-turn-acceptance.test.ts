import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  DurableTurnAcceptance,
  TurnNotAcceptedError,
  turnPayloadHash,
} from '../../src/main/provider/durable-turn-acceptance'
import {
  SqliteTurnAcceptanceStore,
  ensureTurnAcceptanceSchema,
  type TurnAcceptanceKey,
} from '../../src/main/db/turn-acceptance'

describe('DurableTurnAcceptance', () => {
  it('returns domain success for a completed duplicate without dispatching twice', async () => {
    const { acceptance, close } = fixture()
    let dispatches = 0
    const dispatch = async () => { dispatches++ }

    await expect(acceptance.accept(key(), 'payload', dispatch)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      state: 'completed',
    })
    await expect(acceptance.accept(key(), 'payload', dispatch)).resolves.toEqual({
      accepted: true,
      duplicate: true,
      state: 'completed',
    })
    expect(dispatches).toBe(1)
    close()
  })

  it('reports concurrent reserved or dispatching duplicates without claiming success', async () => {
    const { acceptance, close } = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let dispatches = 0
    const first = acceptance.accept(key(), 'payload', async () => {
      dispatches++
      await gate
    })

    await expect(acceptance.accept(key(), 'payload', async () => { dispatches++ })).resolves.toEqual({
      accepted: false,
      duplicate: true,
      state: 'ambiguous',
    })
    release()
    await first
    expect(dispatches).toBe(1)
    close()
  })

  it('reports a reservation left before dispatch as pending', async () => {
    const { acceptance, store, close } = fixture()
    store.reserve(key(), 'payload')

    await expect(acceptance.accept(key(), 'payload', async () => {})).resolves.toEqual({
      accepted: false,
      duplicate: true,
      state: 'pending',
    })
    close()
  })

  it('hard-fails when an origin is reused for a different payload', async () => {
    const { acceptance, close } = fixture()
    await acceptance.accept(key(), 'payload-a', async () => {})

    await expect(acceptance.accept(key(), 'payload-b', async () => {})).rejects.toThrow(
      'turn origin was already used with a different payload',
    )
    close()
  })

  it('releases a definite pre-accept rejection so a retry can dispatch', async () => {
    const { acceptance, close } = fixture()
    let dispatches = 0
    await expect(acceptance.accept(key(), 'payload', async () => {
      dispatches++
      throw new TurnNotAcceptedError('provider was not ready')
    })).rejects.toThrow('provider was not ready')

    await expect(acceptance.accept(key(), 'payload', async () => { dispatches++ })).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
    })
    expect(dispatches).toBe(2)
    close()
  })

  it('leaves a generic dispatch failure ambiguous and never auto-redelivers it', async () => {
    const { acceptance, close } = fixture()
    let dispatches = 0
    await expect(acceptance.accept(key(), 'payload', async () => {
      dispatches++
      throw new Error('provider connection died')
    })).rejects.toThrow('provider connection died')

    await expect(acceptance.accept(key(), 'payload', async () => { dispatches++ })).resolves.toEqual({
      accepted: false,
      duplicate: true,
      state: 'ambiguous',
    })
    expect(dispatches).toBe(1)
    close()
  })

  it('hashes every dispatch-affecting payload field deterministically', () => {
    const base = turnPayloadHash('hello', 'sandbox', [{ url: 'data:image/png;base64,AA', mimeType: 'image/png' }])
    expect(base).toBe(turnPayloadHash('hello', 'sandbox', [{ url: 'data:image/png;base64,AA', mimeType: 'image/png' }]))
    expect(base).not.toBe(turnPayloadHash('changed', 'sandbox', [{ url: 'data:image/png;base64,AA', mimeType: 'image/png' }]))
    expect(base).not.toBe(turnPayloadHash('hello', 'plan', [{ url: 'data:image/png;base64,AA', mimeType: 'image/png' }]))
  })
})

function fixture() {
  const db = new Database(':memory:')
  ensureTurnAcceptanceSchema(db)
  const store = new SqliteTurnAcceptanceStore(() => db)
  return {
    acceptance: new DurableTurnAcceptance(store),
    store,
    close: () => db.close(),
  }
}

function key(): TurnAcceptanceKey {
  return { clientScope: 'scope-a', threadId: 'thread-a', origin: 'origin-a' }
}

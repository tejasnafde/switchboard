import { create } from 'zustand'
import { pruneSpendBlocks, upsertSpendBlock, type SpendBlock } from '@shared/spend-block'
import { createRendererLogger } from '../logger'

const STORAGE_KEY = 'switchboard.spendBlocks'
const log = createRendererLogger('store:spend-block')

/**
 * Remembers (instance, model) pairs refused for extra-usage spend. Persisted
 * because the reset can be days out, so a warning lost on restart would let the
 * user hit the same wall again. Pruned on load and on write.
 */

function load(): SpendBlock[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // `model` must be a real string: it is interpolated into the warning, so a
    // malformed entry would render "undefined billed to extra usage here".
    const clean = parsed.filter(
      (b): b is SpendBlock => typeof b?.model === 'string' && typeof b?.recordedAtMs === 'number',
    )
    return pruneSpendBlocks(clean, Date.now())
  } catch (err) {
    log.warn('could not read persisted spend blocks', err)
    return []
  }
}

function save(blocks: SpendBlock[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blocks))
  } catch (err) {
    log.warn('could not persist spend blocks', err)
  }
}

interface SpendBlockStore {
  blocks: SpendBlock[]
  /** Record a rejection. Replaces any prior entry for the same pair. */
  record: (block: Omit<SpendBlock, 'recordedAtMs'>) => void
}

export const useSpendBlockStore = create<SpendBlockStore>((set, get) => ({
  blocks: load(),

  record: (block) => {
    const now = Date.now()
    const next = upsertSpendBlock(get().blocks, { ...block, recordedAtMs: now }, now)
    log.info('spend block recorded', { model: block.model, reason: block.reason })
    save(next)
    set({ blocks: next })
  },
}))

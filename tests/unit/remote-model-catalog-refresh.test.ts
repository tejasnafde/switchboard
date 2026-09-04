/**
 * Model catalog lifecycle on a long-lived remote backend.
 *
 * Field evidence: the static `src/shared/models.ts` catalogs are stamped with a
 * CLI version ("codex binary's catalog (0.144.1)"). Once a repaired or upgraded
 * remote CLI starts, its OWN list is the truth, and it must replace the static
 * pre-session catalog without shipping a desktop release. Two things blocked
 * that on the remote:
 *
 *  - `if (active.models) return active.models` treats `[]` as a hit, so the ONE
 *    `model/list` call that raced a still-booting app-server poisoned the
 *    session's catalog for its entire life; clients fell back to the static list.
 *  - the resolved-executable cache latched `null`, so a CLI installed by a later
 *    provisioning pass never became visible to the already-running server.
 */
import { describe, it, expect } from 'vitest'
import {
  commitCatalog,
  reconcileSelectedModel,
  shouldRefreshCatalog,
  type CatalogCache,
} from '../../src/main/provider/model-catalog'
import { CODEX_MODELS, type ModelOption } from '@shared/models'

const live = [
  { id: 'gpt-5.7-sol', label: 'GPT-5.7-Sol', tier: 'max' as const },
  { id: 'gpt-5.7-luna', label: 'GPT-5.7-Luna', tier: 'fast' as const },
]

describe('shouldRefreshCatalog', () => {
  it('refreshes when nothing has been cached yet', () => {
    expect(shouldRefreshCatalog(null, 'id-1')).toBe(true)
  })

  it('does not refetch a populated catalog for the same executable', () => {
    const cache: CatalogCache = { models: live, identity: 'id-1' }
    expect(shouldRefreshCatalog(cache, 'id-1')).toBe(false)
  })

  it('refreshes once the executable identity changes under a running server', () => {
    // A provisioning pass upgraded codex while this backend stayed up.
    const cache: CatalogCache = { models: live, identity: 'id-old' }
    expect(shouldRefreshCatalog(cache, 'id-new')).toBe(true)
  })

  it('refreshes when the cached catalog is empty, however it got that way', () => {
    expect(shouldRefreshCatalog({ models: [], identity: 'id-1' }, 'id-1')).toBe(true)
  })
})

describe('commitCatalog', () => {
  it('stores a live list against the executable that produced it', () => {
    expect(commitCatalog(null, live, 'id-1')).toEqual({ models: live, identity: 'id-1' })
  })

  it('REFUSES to cache an empty result, so a raced probe is retried', () => {
    // This is the poisoned-catalog bug: `[]` must never become a cache hit.
    expect(commitCatalog(null, [], 'id-1')).toBeNull()
  })

  it('keeps the previous good list when a later probe comes back empty', () => {
    const good: CatalogCache = { models: live, identity: 'id-1' }
    expect(commitCatalog(good, [], 'id-1')).toBe(good)
  })

  it('replaces a stale list when an upgraded executable reports a new one', () => {
    const stale: CatalogCache = { models: CODEX_MODELS, identity: 'id-old' }
    expect(commitCatalog(stale, live, 'id-new')).toEqual({ models: live, identity: 'id-new' })
  })
})

describe('reconcileSelectedModel', () => {
  it('passes a selection through unchanged before any live catalog exists', () => {
    // No live evidence yet to contradict a persisted or static-default pick.
    expect(reconcileSelectedModel('gpt-5.6-sol', null)).toBe('gpt-5.6-sol')
    expect(reconcileSelectedModel('gpt-5.6-sol', { models: [], identity: 'id-1' })).toBe('gpt-5.6-sol')
  })

  it('keeps a selection the live catalog still offers', () => {
    const cache: CatalogCache = { models: live, identity: 'id-1' }
    expect(reconcileSelectedModel('gpt-5.7-sol', cache)).toBe('gpt-5.7-sol')
  })

  it('drops a selection the live catalog no longer offers, so it does not ride every turn forever', () => {
    // Field case this exists for: 0.153.2's catalog dropped or renamed a model
    // a persisted thread (or the static list's default) still names.
    const cache: CatalogCache = { models: live, identity: 'id-1' }
    expect(reconcileSelectedModel('gpt-4-ancient', cache)).toBeUndefined()
  })

  it('has nothing to reconcile when nothing was selected', () => {
    expect(reconcileSelectedModel(undefined, { models: live, identity: 'id-1' })).toBeUndefined()
  })
})

/**
 * Alias-aware reconciliation, from a live Claude Agent SDK 0.3.260 catalog.
 *
 * Field evidence (roster-dev, OAuth team plan): `supportedModels()` returned
 * the `value` column below - `default`, `opus[1m]`, `claude-fable-5[1m]`,
 * `sonnet`, `haiku` - while an EXPLICIT `claude-sonnet-5` turn completed
 * successfully against that same session and native resume passed. So the
 * live list is a set of ALIAS rows, not the set of accepted ids: exact-id
 * matching would drop `claude-sonnet-5` even though the CLI demonstrably
 * accepts it. Only the `value`s here are field-verified; the labels are
 * cosmetic and never participate in reconciliation.
 */
const claudeLive: ModelOption[] = [
  { id: 'default', label: 'Default', tier: 'balanced' },
  { id: 'opus[1m]', label: 'Opus', tier: 'max' },
  { id: 'claude-fable-5[1m]', label: 'Fable', tier: 'max' },
  { id: 'sonnet', label: 'Sonnet', tier: 'balanced' },
  { id: 'haiku', label: 'Haiku', tier: 'fast' },
]

const claudeCache: CatalogCache = { models: claudeLive, identity: 'claude-id-1' }

describe('reconcileSelectedModel against a live Claude alias catalog', () => {
  it('keeps a row the catalog offers verbatim, suffix and all', () => {
    // The exact value is what the CLI named; it is always sendable.
    expect(reconcileSelectedModel('opus[1m]', claudeCache)).toBe('opus[1m]')
    expect(reconcileSelectedModel('sonnet', claudeCache)).toBe('sonnet')
    expect(reconcileSelectedModel('default', claudeCache)).toBe('default')
  })

  it('keeps claude-sonnet-5, which the alias row `sonnet` covers', () => {
    // The regression this exists for: a persisted picker choice (and the
    // static list's own default) was being silently cleared even though the
    // live CLI completed a turn on it.
    expect(reconcileSelectedModel('claude-sonnet-5', claudeCache)).toBe('claude-sonnet-5')
  })

  it('keeps every shipped static id whose family the live catalog offers', () => {
    for (const id of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      expect(reconcileSelectedModel(id, claudeCache)).toBe(id)
    }
  })

  it('sees through a bracketed capability suffix in either direction', () => {
    // `opus[1m]` is `opus` plus a context-window capability marker.
    expect(reconcileSelectedModel('opus', claudeCache)).toBe('opus')
    expect(reconcileSelectedModel('claude-fable-5', claudeCache)).toBe('claude-fable-5')
    expect(reconcileSelectedModel('fable', claudeCache)).toBe('fable')
  })

  it('combines both rules: a suffixed alias row still covers a full id', () => {
    // `sonnet[1m]` and `claude-sonnet-5[1m]` are both real values in the
    // bundled CLI's catalog; neither may drop a plain `claude-sonnet-5`.
    const suffixedAlias: CatalogCache = {
      models: [{ id: 'sonnet[1m]', label: 'Sonnet 1M', tier: 'balanced' }],
      identity: 'x',
    }
    expect(reconcileSelectedModel('claude-sonnet-5', suffixedAlias)).toBe('claude-sonnet-5')
    const suffixedFull: CatalogCache = {
      models: [{ id: 'claude-sonnet-5[1m]', label: 'Sonnet 5 (1M context)', tier: 'balanced' }],
      identity: 'x',
    }
    expect(reconcileSelectedModel('claude-sonnet-5', suffixedFull)).toBe('claude-sonnet-5')
  })

  it('does NOT let one family vouch for another', () => {
    // No opus row may keep a sonnet id alive, and vice versa.
    const opusOnly: CatalogCache = { models: [claudeLive[1]], identity: 'x' }
    expect(reconcileSelectedModel('claude-sonnet-5', opusOnly)).toBeUndefined()
    const sonnetOnly: CatalogCache = { models: [claudeLive[3]], identity: 'x' }
    expect(reconcileSelectedModel('claude-opus-5', sonnetOnly)).toBeUndefined()
  })

  it('drops a stale id of a live family that this build does not ship', () => {
    // An alias row is not a licence for ANY id shaped like its family - only
    // for the full ids shared/models.ts was actually transcribed from a CLI.
    expect(reconcileSelectedModel('claude-sonnet-3-legacy', claudeCache)).toBeUndefined()
    expect(reconcileSelectedModel('claude-opus-3', claudeCache)).toBeUndefined()
  })

  it('drops an id from a family the live catalog never mentioned', () => {
    const noHaiku: CatalogCache = { models: claudeLive.slice(0, 4), identity: 'x' }
    expect(reconcileSelectedModel('claude-haiku-4-5', noHaiku)).toBeUndefined()
  })

  it('drops an id that is not a Claude model at all', () => {
    expect(reconcileSelectedModel('gpt-5.6-sol', claudeCache)).toBeUndefined()
    expect(reconcileSelectedModel('claude-neo-9', claudeCache)).toBeUndefined()
  })

  it('never INFERS a named model from `default`', () => {
    // `default` carries no family, so nothing can be deduced from its name.
    // (The real CLI stamps every row with `resolvedModel`, so a live `default`
    // row does say what it resolves to - that is rule 2 below, the CLI's own
    // answer, not an inference from the string `default`.)
    const defaultOnly: CatalogCache = { models: [claudeLive[0]], identity: 'x' }
    expect(reconcileSelectedModel('claude-sonnet-5', defaultOnly)).toBeUndefined()
    expect(reconcileSelectedModel('sonnet', defaultOnly)).toBeUndefined()
  })

  it('uses ModelInfo.resolvedModel when the CLI supplies it', () => {
    // SDK 0.3.260 ships `resolvedModel` on ModelInfo ("Canonical wire model id
    // this row's `value` resolves to (e.g. 'sonnet' -> 'claude-sonnet-5')"),
    // and the CLI bundled with it stamps EVERY catalog row with it
    // unconditionally - its row builder returns
    // `{value, resolvedModel, displayName, description, ...}`. The roster-dev
    // report listed only the `value` column, so this is the CLI's contract
    // rather than a transcribed row; when present it is the CLI's own answer
    // and outranks any inference of ours, so it is checked before them.
    const withResolved: CatalogCache = {
      models: [{ id: 'sonnet', label: 'Sonnet', tier: 'balanced', resolvedModel: 'claude-sonnet-5-20260215' }],
      identity: 'x',
    }
    expect(reconcileSelectedModel('claude-sonnet-5-20260215', withResolved)).toBe('claude-sonnet-5-20260215')
  })
})

describe('reconcileSelectedModel keeps Codex exact-id semantics', () => {
  it('still drops a codex id the live catalog dropped, alias rules or not', () => {
    // Codex ids carry no Claude family names and no capability suffixes, so
    // none of the alias rules can fire for them.
    const cache: CatalogCache = { models: live, identity: 'id-1' }
    expect(reconcileSelectedModel('gpt-4-ancient', cache)).toBeUndefined()
    expect(reconcileSelectedModel('gpt-5.6-sol', cache)).toBeUndefined()
    expect(reconcileSelectedModel('gpt-5.7-sol', cache)).toBe('gpt-5.7-sol')
  })
})

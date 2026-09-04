/**
 * Model-catalog lifecycle, shared by the Claude and Codex adapters.
 *
 * `src/shared/models.ts` ships a static list per provider, stamped with the CLI
 * version it was transcribed from. It exists only to populate the picker BEFORE
 * a session can answer for itself; once a provider process is up, its own
 * `supportedModels()` / `model/list` is the truth. On a remote that matters
 * more than on desktop, because the CLI there is repaired and upgraded by
 * provisioning between releases - a model the shipped catalog has never heard
 * of must appear without waiting for a desktop build.
 *
 * Two rules make that work against a long-lived backend:
 *
 *  - An EMPTY result is never cached. A `model/list` that raced a still-booting
 *    app-server used to be stored as a hit (`[]` is truthy), pinning the
 *    session to the static catalog for its whole life.
 *  - The cache is keyed on the resolved executable's identity, so a CLI that
 *    provisioning upgraded under a running server invalidates the list it
 *    produced instead of serving it indefinitely.
 */
import { CLAUDE_MODELS, type ModelOption } from '@shared/models'

export interface CatalogCache {
  models: ModelOption[]
  /** Identity of the executable that produced this list (see managed-bin). */
  identity: string | null
}

/** Should we ask the provider for its catalog again? */
export function shouldRefreshCatalog(cache: CatalogCache | null, identity: string | null): boolean {
  if (!cache) return true
  if (cache.models.length === 0) return true
  return cache.identity !== identity
}

/**
 * Fold a freshly probed list into the cache. Returns the previous cache
 * unchanged when the probe came back empty, so the next call retries.
 */
export function commitCatalog(
  cache: CatalogCache | null,
  models: ModelOption[],
  identity: string | null,
): CatalogCache | null {
  if (models.length === 0) return cache
  return { models, identity }
}

/**
 * The model id to actually put on a Codex `thread/start`/`turn/start` request,
 * and the shared answer to "is this selection still supported?".
 *
 * A selection made before the live catalog existed - a persisted picker
 * choice, or the static list's default - must not go on being sent once the
 * live catalog no longer offers it: nothing else in this path ever revisits
 * that choice, so a dropped or renamed model would otherwise ride every turn
 * indefinitely. Once a live catalog exists, an id NO ROW COVERS is dropped so
 * the CLI's own default takes over; before that (no live catalog fetched yet
 * for this session), the selection passes through unchanged - there is no
 * live evidence to contradict it.
 *
 * "Covers", not "equals". A live Claude catalog is a list of ALIASES, not the
 * set of ids the CLI accepts. Claude Agent SDK 0.3.260 on roster-dev returned
 * `default`, `opus[1m]`, `claude-fable-5[1m]`, `sonnet`, `haiku` - yet an
 * explicit `claude-sonnet-5` turn completed on that same session. Exact-id
 * matching therefore cleared a selection the provider had just honoured, and
 * did it silently. See `covers()` for the four ways a row vouches for an id.
 *
 * The selection is returned VERBATIM when kept - never rewritten to the row
 * that covered it. `sonnet` and `claude-sonnet-5` are different requests (the
 * alias floats to whatever the account resolves it to), and the user picked
 * one of them.
 */
export function reconcileSelectedModel(
  selected: string | undefined,
  cache: CatalogCache | null,
): string | undefined {
  if (!selected) return selected
  if (!cache || cache.models.length === 0) return selected
  return cache.models.some((m) => covers(m, selected)) ? selected : undefined
}

/** One trailing bracketed capability marker: `opus[1m]` -> `opus`. */
const CAPABILITY_SUFFIX = /\[[^\]]*\]$/

/**
 * Claude's bare family aliases. A live row may be one of these instead of a
 * full id, and the CLI resolves it per account at request time.
 */
const CLAUDE_FAMILY = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-[\w.]+)*$/

/** Full ids this build actually shipped, i.e. transcribed from a real CLI. */
const SHIPPED_CLAUDE_IDS = new Set(CLAUDE_MODELS.map((m) => m.id))

function baseId(id: string): string {
  return id.replace(CAPABILITY_SUFFIX, '').trim().toLowerCase()
}

/** `claude-sonnet-5` -> `sonnet`, `opus[1m]` -> `opus`, `default` -> null. */
function familyOf(id: string): string | null {
  return baseId(id).match(CLAUDE_FAMILY)?.[1] ?? null
}

/** Is this id a bare family name (`sonnet`) rather than a full id? */
function isBareAlias(id: string): boolean {
  const base = baseId(id)
  return familyOf(base) === base
}

/**
 * Does this catalog row vouch for `selected`? Four rules, narrowest first:
 *
 *  1. The row IS the selection. Always sendable, suffix and all.
 *  2. The CLI told us what the row resolves to. SDK 0.3.260 added
 *     `ModelInfo.resolvedModel` ("Lets hosts match a persisted explicit id
 *     against the alias row that covers it") - its own answer beats ours.
 *  3. Same id modulo a capability suffix: `opus[1m]` covers `opus`. The
 *     bundled CLI's own wording is "append [1m] to the model name for 1M" -
 *     the suffix is a modifier on a model NAME, so a listed `x[1m]` row is
 *     proof that `x` is itself a model this account has.
 *  4. A bare family alias covers the full ids of that family THIS BUILD
 *     SHIPS, and vice versa: `sonnet` covers `claude-sonnet-5`.
 *
 * Rule 4 is deliberately gated on `SHIPPED_CLAUDE_IDS` rather than on the
 * family name alone. An alias row proves the account has that family, not
 * that any string shaped like it is a real model - so `claude-sonnet-3-legacy`
 * still gets dropped, which is the whole point of reconciling. `default`
 * names no family, so it vouches for nothing but itself.
 *
 * Codex ids carry no Claude family name and no suffix, so rules 2-4 cannot
 * fire for them and their exact-match semantics are unchanged.
 */
function covers(row: ModelOption, selected: string): boolean {
  if (row.id === selected) return true
  if (row.resolvedModel && baseId(row.resolvedModel) === baseId(selected)) return true
  if (baseId(row.id) === baseId(selected)) return true

  const family = familyOf(row.id)
  if (!family || family !== familyOf(selected)) return false
  const [alias, full] = isBareAlias(row.id) ? [row.id, selected] : [selected, row.id]
  return isBareAlias(alias) && SHIPPED_CLAUDE_IDS.has(baseId(full))
}

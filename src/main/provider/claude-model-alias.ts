/**
 * How a live Claude catalog row vouches for a selected model id. A Claude
 * catalog lists aliases (`sonnet`, `opus[1m]`), not every id the CLI accepts,
 * so exact matching would drop selections the provider honours. Pass
 * `claudeRowCovers` to reconcileSelectedModel for Claude catalogs.
 */
import { CLAUDE_MODELS, type ModelOption } from '@shared/models'
import type { RowCovers } from './model-catalog'

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
 */
export const claudeRowCovers: RowCovers = (row, selected) => {
  if (row.id === selected) return true
  if (row.resolvedModel && baseId(row.resolvedModel) === baseId(selected)) return true
  if (baseId(row.id) === baseId(selected)) return true

  const family = familyOf(row.id)
  if (!family || family !== familyOf(selected)) return false
  const [alias, full] = isBareAlias(row.id) ? [row.id, selected] : [selected, row.id]
  return isBareAlias(alias) && SHIPPED_CLAUDE_IDS.has(baseId(full))
}

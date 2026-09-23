/**
 * Is a picked model still offered by the provider's live catalog? One answer
 * for the composer (warn before send) and the adapters (fall back before a
 * turn), so the two can never disagree.
 */
import { CLAUDE_MODELS, type ModelOption } from './models'
import type { AgentType } from './types'

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
 * did it silently. The Claude rules are `claudeRowCovers` below, passed in
 * as `covers`; the default is an exact match.
 *
 * The selection is returned VERBATIM when kept - never rewritten to the row
 * that covered it. `sonnet` and `claude-sonnet-5` are different requests (the
 * alias floats to whatever the account resolves it to), and the user picked
 * one of them.
 */
export function reconcileSelectedModel(
  selected: string | undefined,
  cache: { models: readonly ModelOption[] } | null | undefined,
  covers: RowCovers = exactRow,
): string | undefined {
  if (!selected) return selected
  if (!cache || cache.models.length === 0) return selected
  return cache.models.some((m) => covers(m, selected)) ? selected : undefined
}

/** Does this catalog row vouch for `selected`? Provider-specific. */
export type RowCovers = (row: ModelOption, selected: string) => boolean

/** Exact ids only: right for Codex, whose rows are the ids it accepts. */
export const exactRow: RowCovers = (row, selected) => row.id === selected

/**
 * How a live Claude catalog row vouches for a selected model id. A Claude
 * catalog lists aliases (`sonnet`, `opus[1m]`), not every id the CLI accepts,
 * so exact matching would drop selections the provider honours. Pass
 * `claudeRowCovers` to reconcileSelectedModel for Claude catalogs.
 */

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

/** The matching rule for an agent's catalog. */
export function coversFor(agentType: AgentType | undefined): RowCovers {
  return agentType === 'claude-code' ? claudeRowCovers : exactRow
}

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
import type { ModelOption } from '@shared/models'

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
 * did it silently. The Claude rules live in claude-model-alias.ts and are
 * passed in as `covers`; the default is an exact match.
 *
 * The selection is returned VERBATIM when kept - never rewritten to the row
 * that covered it. `sonnet` and `claude-sonnet-5` are different requests (the
 * alias floats to whatever the account resolves it to), and the user picked
 * one of them.
 */
export function reconcileSelectedModel(
  selected: string | undefined,
  cache: CatalogCache | null,
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

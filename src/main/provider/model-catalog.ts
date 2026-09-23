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

export { reconcileSelectedModel, exactRow, type RowCovers } from '@shared/model-reconcile'

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

import type { ModelOption } from '@shared/models'

/** Case-insensitive substring match on the model id or its label. */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return models
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
}

export interface GroupedModels {
  ungrouped: ModelOption[]
  groups: { provider: string; models: ModelOption[] }[]
}

/**
 * Groups models by provider prefix (the id before the first `/`), in first-seen
 * order. Ids without a prefix stay ungrouped and list first.
 */
export function groupModelsByProvider(models: ModelOption[]): GroupedModels {
  const ungrouped: ModelOption[] = []
  const groups = new Map<string, ModelOption[]>()
  for (const m of models) {
    const slash = m.id.indexOf('/')
    if (slash === -1) {
      ungrouped.push(m)
      continue
    }
    const provider = m.id.slice(0, slash)
    const group = groups.get(provider)
    if (group) group.push(m)
    else groups.set(provider, [m])
  }
  return { ungrouped, groups: [...groups].map(([provider, list]) => ({ provider, models: list })) }
}

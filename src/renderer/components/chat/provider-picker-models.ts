import type { ModelOption } from '@shared/models'
import { searchModels } from '@shared/model-search'

/** The models matching `query`, best first (`searchModels`); all of them when it is empty. */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  return searchModels(models, query)
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

/** One row the picker's arrow keys move over; `id` '' is the agent's default. */
export interface PickerRow {
  id: string
  label: string
}

/** The rows in the order the list shows them: Default, ungrouped, then each group. */
export function pickerRows(grouped: GroupedModels): PickerRow[] {
  return [{ id: '', label: 'Default' }, ...grouped.ungrouped, ...grouped.groups.flatMap((g) => g.models)]
}

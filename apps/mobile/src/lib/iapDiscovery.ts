import type { SshIapTarget } from '@shared/machines'

export interface SavedIapTarget {
  project: string
  zone: string
  instance: string
}

export interface IapTargetSelection {
  available: SshIapTarget[]
  discoveredCount: number
  alreadyAddedCount: number
}

function targetKey(target: SavedIapTarget): string {
  return [target.project, target.zone, target.instance]
    .map((part) => part.trim().toLowerCase())
    .join('\0')
}

export function selectAvailableIapTargets(
  sources: SshIapTarget[][],
  saved: SavedIapTarget[],
): IapTargetSelection {
  const discovered = new Map<string, SshIapTarget>()
  for (const source of sources) {
    for (const target of source) {
      const key = targetKey(target)
      if (!discovered.has(key)) discovered.set(key, target)
    }
  }

  const savedKeys = new Set(saved.map(targetKey))
  const available = [...discovered].flatMap(([key, target]) =>
    savedKeys.has(key) ? [] : [target],
  )
  const alreadyAddedCount = discovered.size - available.length
  return { available, discoveredCount: discovered.size, alreadyAddedCount }
}

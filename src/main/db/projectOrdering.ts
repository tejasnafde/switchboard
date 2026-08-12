export interface ProjectOrderRow {
  path: string
  workspaceId: string | null
  addedAt: number
}

export interface ProjectPosition {
  path: string
  workspaceId: string | null
  sortOrder: number
}

export function deriveProjectPositions(
  rows: ProjectOrderRow[],
  savedOrder: string[] | null,
): ProjectPosition[] {
  const preferred = Array.isArray(savedOrder)
    ? [...new Set(savedOrder.filter((path): path is string => typeof path === 'string'))]
    : []
  const rank = new Map(preferred.map((path, index) => [path, index]))
  const ordered = [...rows].sort((a, b) => {
    const aRank = rank.get(a.path)
    const bRank = rank.get(b.path)
    if (aRank !== undefined || bRank !== undefined) {
      if (aRank === undefined) return 1
      if (bRank === undefined) return -1
      return aRank - bRank
    }
    return b.addedAt - a.addedAt || a.path.localeCompare(b.path)
  })
  const nextByWorkspace = new Map<string | null, number>()
  return ordered.map((row) => {
    const sortOrder = nextByWorkspace.get(row.workspaceId) ?? 0
    nextByWorkspace.set(row.workspaceId, sortOrder + 1)
    return { path: row.path, workspaceId: row.workspaceId, sortOrder }
  })
}

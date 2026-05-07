/**
 * Pure dependency-graph primitives for the Branches screen.
 *
 * Nodes are worktrees-on-branches; edges encode "child depends on parent"
 * (i.e. parent's diff must land in trunk before child can be cleanly
 * rebased). The merge orchestrator (mergePlanner.ts) consumes
 * `mergePlan(...)` and walks `Plan.steps` in order.
 *
 * No git, no IO, no IPC — keep this module purely algorithmic so it stays
 * easy to test and reason about.
 */

export interface BranchNode {
  /** Branch name, e.g. `kanban/auth-12345678` or `fork/billing-fix`. */
  branch: string
  /** Absolute worktree path on disk. */
  worktreePath: string
  /** Current HEAD SHA at graph-build time (informational). */
  head: string
}

export interface BranchEdge {
  /** Foundation branch — must merge first. */
  parent: string
  /** Dependent branch — rebases atop parent in trunk. */
  child: string
}

export interface PlanStep {
  branch: string
  worktreePath: string
  /**
   * Steps with the same `parallelGroup` have no inter-dependency and
   * could in principle be processed concurrently. v1 still executes
   * sequentially; this is metadata for the UI + future parallel-execute.
   */
  parallelGroup: number
}

export interface Plan {
  /** The trunk branch we are merging back to (typically `main`). */
  trunk: string
  /** Steps sorted by (parallelGroup ASC, branch name ASC). */
  steps: PlanStep[]
}

export type CycleResult =
  | { hasCycle: false }
  | { hasCycle: true; cycleNodes: string[] }

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

interface Adjacency {
  byBranch: Map<string, BranchNode>
  outgoing: Map<string, Set<string>> // parent → children
  incoming: Map<string, Set<string>> // child → parents
}

function buildAdjacency(nodes: BranchNode[], edges: BranchEdge[]): Adjacency {
  const byBranch = new Map<string, BranchNode>()
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()

  for (const n of nodes) {
    byBranch.set(n.branch, n)
    outgoing.set(n.branch, new Set())
    incoming.set(n.branch, new Set())
  }

  for (const e of edges) {
    if (!byBranch.has(e.parent)) {
      throw new Error(`Edge references unknown parent node: ${e.parent}`)
    }
    if (!byBranch.has(e.child)) {
      throw new Error(`Edge references unknown child node: ${e.child}`)
    }
    outgoing.get(e.parent)!.add(e.child)
    incoming.get(e.child)!.add(e.parent)
  }

  return { byBranch, outgoing, incoming }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Kahn's algorithm with alphabetical tie-breaking. Throws if the graph has
 * a cycle; use `detectCycle` first if you need the offending nodes.
 */
export function topoSort(nodes: BranchNode[], edges: BranchEdge[]): BranchNode[] {
  const { byBranch, outgoing, incoming } = buildAdjacency(nodes, edges)
  const inDegree = new Map<string, number>()
  for (const [b, ins] of incoming) inDegree.set(b, ins.size)

  const ready: string[] = []
  for (const [b, deg] of inDegree) {
    if (deg === 0) ready.push(b)
  }
  ready.sort()

  const result: BranchNode[] = []
  while (ready.length > 0) {
    const next = ready.shift()!
    result.push(byBranch.get(next)!)
    const newlyReady: string[] = []
    for (const child of outgoing.get(next)!) {
      const newDeg = inDegree.get(child)! - 1
      inDegree.set(child, newDeg)
      if (newDeg === 0) newlyReady.push(child)
    }
    if (newlyReady.length > 0) {
      ready.push(...newlyReady)
      ready.sort()
    }
  }

  if (result.length !== nodes.length) {
    const unvisited = nodes.filter((n) => !result.includes(n)).map((n) => n.branch)
    throw new Error(
      `Dependency graph contains a cycle (unresolved: ${unvisited.join(', ')})`,
    )
  }
  return result
}

/**
 * DFS three-coloring (white/gray/black). On hit, walks back up the recursion
 * to collect every gray node — that's the cycle path.
 */
export function detectCycle(nodes: BranchNode[], edges: BranchEdge[]): CycleResult {
  const { byBranch, outgoing } = buildAdjacency(nodes, edges)
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const b of byBranch.keys()) color.set(b, WHITE)
  const cycleNodes = new Set<string>()

  function dfs(branch: string): boolean {
    color.set(branch, GRAY)
    for (const child of outgoing.get(branch)!) {
      const c = color.get(child)
      if (c === GRAY) {
        cycleNodes.add(child)
        cycleNodes.add(branch)
        return true
      }
      if (c === WHITE && dfs(child)) {
        cycleNodes.add(branch)
        return true
      }
    }
    color.set(branch, BLACK)
    return false
  }

  for (const b of byBranch.keys()) {
    if (color.get(b) === WHITE && dfs(b)) {
      return { hasCycle: true, cycleNodes: [...cycleNodes].sort() }
    }
  }
  return { hasCycle: false }
}

/**
 * Builds a `Plan` from the graph. Each step carries its `parallelGroup`,
 * which is its longest-path depth from the set of roots. Steps are returned
 * sorted by (parallelGroup ASC, branch ASC) for deterministic output.
 *
 * Throws if the graph has a cycle (error names the unresolved nodes).
 */
export function mergePlan(opts: {
  nodes: BranchNode[]
  edges: BranchEdge[]
  trunk: string
}): Plan {
  const { nodes, edges, trunk } = opts
  const { outgoing, incoming } = buildAdjacency(nodes, edges)
  const inDegree = new Map<string, number>()
  for (const [b, ins] of incoming) inDegree.set(b, ins.size)

  const groupOf = new Map<string, number>()
  let frontier = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([b]) => b)
    .sort()
  let group = 0

  while (frontier.length > 0) {
    const next: string[] = []
    for (const b of frontier) {
      groupOf.set(b, group)
      for (const child of outgoing.get(b)!) {
        const newDeg = inDegree.get(child)! - 1
        inDegree.set(child, newDeg)
        if (newDeg === 0) next.push(child)
      }
    }
    next.sort()
    frontier = next
    group += 1
  }

  if (groupOf.size !== nodes.length) {
    const unvisited = nodes.filter((n) => !groupOf.has(n.branch)).map((n) => n.branch)
    throw new Error(
      `Dependency graph contains a cycle (unresolved: ${unvisited.join(', ')})`,
    )
  }

  const steps: PlanStep[] = nodes
    .map((n) => ({
      branch: n.branch,
      worktreePath: n.worktreePath,
      parallelGroup: groupOf.get(n.branch)!,
    }))
    .sort((a, b) =>
      a.parallelGroup !== b.parallelGroup
        ? a.parallelGroup - b.parallelGroup
        : a.branch.localeCompare(b.branch),
    )
  return { trunk, steps }
}

/**
 * Pure dependency-graph tests for the Branches screen.
 *
 * The graph is the central abstraction for the merge orchestrator: nodes are
 * worktrees-on-branches, edges are "child depends on parent". We test:
 *   - topoSort: deterministic ordering, cycle rejection, edge integrity
 *   - detectCycle: BFS color-coding finds cycles + reports offending nodes
 *   - mergePlan: produces parallelGroup-bucketed steps for the planner
 *
 * No git, no IPC, no IO — exercise the algorithm directly.
 */

import { describe, it, expect } from 'vitest'
import {
  topoSort,
  detectCycle,
  mergePlan,
  type BranchNode,
  type BranchEdge,
} from '../../src/main/branches/dependencyGraph'

const node = (branch: string, head = 'sha'): BranchNode => ({
  branch,
  worktreePath: `/repo/.switchboard/worktrees/${branch}`,
  head,
})

describe('topoSort', () => {
  it('returns nodes alphabetically when no edges', () => {
    const nodes = [node('b'), node('a')]
    expect(topoSort(nodes, []).map((n) => n.branch)).toEqual(['a', 'b'])
  })

  it('respects a single linear chain a → b → c', () => {
    const nodes = [node('c'), node('a'), node('b')]
    const edges: BranchEdge[] = [
      { parent: 'a', child: 'b' },
      { parent: 'b', child: 'c' },
    ]
    expect(topoSort(nodes, edges).map((n) => n.branch)).toEqual(['a', 'b', 'c'])
  })

  it('orders independent siblings alphabetically (deterministic)', () => {
    const nodes = [node('user-auth'), node('billing-fix'), node('schema-refactor')]
    const edges: BranchEdge[] = [
      { parent: 'schema-refactor', child: 'user-auth' },
      { parent: 'schema-refactor', child: 'billing-fix' },
    ]
    expect(topoSort(nodes, edges).map((n) => n.branch)).toEqual([
      'schema-refactor',
      'billing-fix',
      'user-auth',
    ])
  })

  it('throws on cycle a → b → a', () => {
    const nodes = [node('a'), node('b')]
    const edges: BranchEdge[] = [
      { parent: 'a', child: 'b' },
      { parent: 'b', child: 'a' },
    ]
    expect(() => topoSort(nodes, edges)).toThrow(/cycle/i)
  })

  it('handles disconnected components with stable ordering', () => {
    const nodes = [node('d'), node('c'), node('b'), node('a')]
    const edges: BranchEdge[] = [
      { parent: 'a', child: 'b' },
      { parent: 'c', child: 'd' },
    ]
    const sorted = topoSort(nodes, edges).map((n) => n.branch)
    // Per-edge constraints
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'))
    expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'))
    // Deterministic specific output: a,c are roots → alphabetical; after
    // a is consumed b becomes ready and re-sorts ahead of c.
    expect(sorted).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns an empty array for empty input', () => {
    expect(topoSort([], [])).toEqual([])
  })

  it('rejects edges that reference unknown nodes', () => {
    expect(() => topoSort([node('a')], [{ parent: 'a', child: 'ghost' }])).toThrow(/ghost/)
    expect(() => topoSort([node('a')], [{ parent: 'phantom', child: 'a' }])).toThrow(/phantom/)
  })
})

describe('detectCycle', () => {
  it('reports false for an acyclic graph', () => {
    const result = detectCycle([node('a'), node('b')], [{ parent: 'a', child: 'b' }])
    expect(result.hasCycle).toBe(false)
  })

  it('reports the cycle nodes for a 3-cycle', () => {
    const result = detectCycle(
      [node('a'), node('b'), node('c')],
      [
        { parent: 'a', child: 'b' },
        { parent: 'b', child: 'c' },
        { parent: 'c', child: 'a' },
      ],
    )
    expect(result.hasCycle).toBe(true)
    if (result.hasCycle) {
      expect([...result.cycleNodes].sort()).toEqual(['a', 'b', 'c'])
    }
  })

  it('detects a self-loop', () => {
    const result = detectCycle([node('a')], [{ parent: 'a', child: 'a' }])
    expect(result.hasCycle).toBe(true)
  })

  it('returns false on an empty graph', () => {
    expect(detectCycle([], [])).toEqual({ hasCycle: false })
  })
})

describe('mergePlan', () => {
  it('produces an empty plan for an empty graph', () => {
    const plan = mergePlan({ nodes: [], edges: [], trunk: 'main' })
    expect(plan.steps).toEqual([])
    expect(plan.trunk).toBe('main')
  })

  it('puts independent nodes into the same parallel group', () => {
    const nodes = [node('a'), node('b'), node('c')]
    const plan = mergePlan({ nodes, edges: [], trunk: 'main' })
    expect(plan.steps.every((s) => s.parallelGroup === 0)).toBe(true)
  })

  it('puts dependents in higher groups than their parents', () => {
    const nodes = [node('foundation'), node('feature-a'), node('feature-b')]
    const edges: BranchEdge[] = [
      { parent: 'foundation', child: 'feature-a' },
      { parent: 'foundation', child: 'feature-b' },
    ]
    const plan = mergePlan({ nodes, edges, trunk: 'main' })
    const byBranch = Object.fromEntries(plan.steps.map((s) => [s.branch, s]))
    expect(byBranch.foundation.parallelGroup).toBe(0)
    expect(byBranch['feature-a'].parallelGroup).toBe(1)
    expect(byBranch['feature-b'].parallelGroup).toBe(1)
  })

  it('chains depth correctly: a → b → c becomes groups 0,1,2', () => {
    const nodes = [node('a'), node('b'), node('c')]
    const edges: BranchEdge[] = [
      { parent: 'a', child: 'b' },
      { parent: 'b', child: 'c' },
    ]
    const plan = mergePlan({ nodes, edges, trunk: 'main' })
    const byBranch = Object.fromEntries(plan.steps.map((s) => [s.branch, s]))
    expect(byBranch.a.parallelGroup).toBe(0)
    expect(byBranch.b.parallelGroup).toBe(1)
    expect(byBranch.c.parallelGroup).toBe(2)
  })

  it('multi-parent join: c depends on a and b → c is max(a,b)+1', () => {
    const nodes = [node('a'), node('b'), node('c'), node('x')]
    const edges: BranchEdge[] = [
      { parent: 'x', child: 'a' },
      { parent: 'x', child: 'b' },
      { parent: 'a', child: 'c' },
      { parent: 'b', child: 'c' },
    ]
    const plan = mergePlan({ nodes, edges, trunk: 'main' })
    const byBranch = Object.fromEntries(plan.steps.map((s) => [s.branch, s]))
    expect(byBranch.x.parallelGroup).toBe(0)
    expect(byBranch.a.parallelGroup).toBe(1)
    expect(byBranch.b.parallelGroup).toBe(1)
    expect(byBranch.c.parallelGroup).toBe(2)
  })

  it('preserves worktreePath in each step', () => {
    const nodes = [node('a')]
    const plan = mergePlan({ nodes, edges: [], trunk: 'main' })
    expect(plan.steps[0].worktreePath).toBe('/repo/.switchboard/worktrees/a')
  })

  it('throws on cycle with the offending nodes named in the error', () => {
    const cyclic = () =>
      mergePlan({
        nodes: [node('a'), node('b')],
        edges: [
          { parent: 'a', child: 'b' },
          { parent: 'b', child: 'a' },
        ],
        trunk: 'main',
      })
    expect(cyclic).toThrow(/cycle/i)
    expect(cyclic).toThrow(/a/)
    expect(cyclic).toThrow(/b/)
  })

  it('orders steps by (parallelGroup, branch-name) so output is deterministic', () => {
    const nodes = [node('z'), node('a'), node('m')]
    const edges: BranchEdge[] = [
      { parent: 'a', child: 'z' },
      { parent: 'a', child: 'm' },
    ]
    const plan = mergePlan({ nodes, edges, trunk: 'main' })
    expect(plan.steps.map((s) => s.branch)).toEqual(['a', 'm', 'z'])
  })
})

/**
 * Tests for the auto-suggested-edge detector.
 *
 * For each unordered pair of branches, we run `git merge-tree` (via the
 * injected helper) and report a suggested edge when the result is
 * conflicted. Direction heuristic: the older branch (lower
 * first-commit timestamp) becomes the parent — the working theory is
 * "older branches are foundations, newer ones build on them."
 */

import { describe, it, expect, vi } from 'vitest'
import { detectOverlaps } from '../../src/main/branches/overlapDetector'
import type { BranchNode } from '../../src/main/branches/dependencyGraph'

const mkNode = (branch: string): BranchNode => ({
  branch,
  worktreePath: `/repo/.switchboard/worktrees/${branch}`,
  head: 'sha',
})

describe('detectOverlaps', () => {
  it('returns no edges when all pairs merge cleanly', async () => {
    const nodes = [mkNode('a'), mkNode('b')]
    const mergeTreeWriteTree = vi.fn(async () => ({
      treeSha: 'tree',
      conflictFiles: [],
      conflicted: false,
    }))
    const branchTimestamp = vi.fn(async (b: string) => (b === 'a' ? 100 : 200))
    const result = await detectOverlaps(nodes, '/repo', { mergeTreeWriteTree, branchTimestamp })
    expect(result).toEqual([])
  })

  it('suggests an edge for any conflicting pair, oldest as parent', async () => {
    const nodes = [mkNode('young'), mkNode('old')]
    const mergeTreeWriteTree = vi.fn(async () => ({
      treeSha: null,
      conflictFiles: ['shared.ts'],
      conflicted: true,
    }))
    const branchTimestamp = vi.fn(async (b: string) => (b === 'old' ? 100 : 500))
    const result = await detectOverlaps(nodes, '/repo', { mergeTreeWriteTree, branchTimestamp })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      parent: 'old',
      child: 'young',
      conflictFiles: ['shared.ts'],
    })
  })

  it('skips pairs where the existing-edge predicate says edge already exists', async () => {
    const nodes = [mkNode('a'), mkNode('b')]
    const mergeTreeWriteTree = vi.fn(async () => ({
      treeSha: null,
      conflictFiles: ['x.ts'],
      conflicted: true,
    }))
    const branchTimestamp = vi.fn(async (b: string) => (b === 'a' ? 100 : 200))
    const existingEdge = vi.fn((p, c) => p === 'a' && c === 'b')
    const result = await detectOverlaps(nodes, '/repo', {
      mergeTreeWriteTree,
      branchTimestamp,
      existingEdge,
    })
    expect(result).toEqual([])
  })

  it('does not double-call mergeTreeWriteTree per pair (only one direction)', async () => {
    const nodes = [mkNode('a'), mkNode('b'), mkNode('c')]
    const mergeTreeWriteTree = vi.fn(async () => ({
      treeSha: 'tree',
      conflictFiles: [],
      conflicted: false,
    }))
    const branchTimestamp = vi.fn(async (b: string) => (b === 'a' ? 100 : b === 'b' ? 200 : 300))
    await detectOverlaps(nodes, '/repo', { mergeTreeWriteTree, branchTimestamp })
    // 3 nodes → 3 unordered pairs (a-b, a-c, b-c), one merge-tree call each
    expect(mergeTreeWriteTree).toHaveBeenCalledTimes(3)
  })

  it('returns empty for fewer than two nodes', async () => {
    const mergeTreeWriteTree = vi.fn()
    const branchTimestamp = vi.fn()
    expect(await detectOverlaps([], '/repo', { mergeTreeWriteTree, branchTimestamp })).toEqual([])
    expect(await detectOverlaps([mkNode('a')], '/repo', { mergeTreeWriteTree, branchTimestamp })).toEqual([])
  })
})

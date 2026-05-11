/**
 * Unified-diff parser for the editor's git gutter. Goal: turn raw
 * `git diff HEAD --no-color -- <file>` output into per-line hunks the
 * gutter extension paints (green = added, yellow = modified, red =
 * deleted-marker on the surviving line).
 *
 * We classify hunks by their `@@ -a,b +c,d @@` header:
 *   - pure additions (no removed context lines) → kind 'add'
 *   - pure deletions → kind 'del' (anchored to the line *after* the
 *     removed block in the new file)
 *   - mixed adds + dels → kind 'mod' for each surviving added line
 */
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../../src/main/git/diffHunks'

describe('parseUnifiedDiff', () => {
  it('returns empty array on empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })

  it('parses a pure addition hunk', () => {
    const diff = `diff --git a/foo b/foo
index abc..def 100644
--- a/foo
+++ b/foo
@@ -3,0 +4,2 @@
+new line one
+new line two
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'add', startLine: 4, endLine: 5 },
    ])
  })

  it('parses a pure deletion hunk anchored to the next surviving line', () => {
    const diff = `diff --git a/foo b/foo
index abc..def 100644
--- a/foo
+++ b/foo
@@ -3,2 +2,0 @@
-deleted one
-deleted two
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'del', startLine: 3, endLine: 3 },
    ])
  })

  it('parses a modification (1 deleted + 1 added) as mod on the new line', () => {
    const diff = `diff --git a/foo b/foo
--- a/foo
+++ b/foo
@@ -10,1 +10,1 @@
-old
+new
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'mod', startLine: 10, endLine: 10 },
    ])
  })

  it('parses multi-hunk diff', () => {
    const diff = `diff --git a/foo b/foo
--- a/foo
+++ b/foo
@@ -1,1 +1,1 @@
-a
+A
@@ -10,0 +11,2 @@
+x
+y
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'mod', startLine: 1, endLine: 1 },
      { kind: 'add', startLine: 11, endLine: 12 },
    ])
  })

  it('handles single-number hunk headers (`@@ -3 +3 @@` shorthand for ,1 ranges)', () => {
    const diff = `diff --git a/foo b/foo
--- a/foo
+++ b/foo
@@ -3 +3 @@
-old
+new
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'mod', startLine: 3, endLine: 3 },
    ])
  })

  it('handles add+del where adds outnumber dels (extra lines beyond the modified zone are adds)', () => {
    const diff = `diff --git a/foo b/foo
--- a/foo
+++ b/foo
@@ -5,1 +5,3 @@
-old
+new
+brand
+new line
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'mod', startLine: 5, endLine: 5 },
      { kind: 'add', startLine: 6, endLine: 7 },
    ])
  })

  it('skips diff headers and context lines', () => {
    const diff = `diff --git a/foo b/foo
--- a/foo
+++ b/foo
@@ -1,5 +1,6 @@
 unchanged
 unchanged
+inserted
 unchanged
 unchanged
 unchanged
`
    const hunks = parseUnifiedDiff(diff)
    expect(hunks).toEqual([
      { kind: 'add', startLine: 3, endLine: 3 },
    ])
  })
})

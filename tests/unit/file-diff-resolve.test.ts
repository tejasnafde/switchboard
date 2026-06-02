/**
 * The write-back contract for the in-chat diff cards: given the baseline +
 * agent's new content, build a @pierre/diffs metadata object, let the user
 * accept/reject hunks, and reconstruct the exact file bytes to write to disk.
 *
 * These run the real @pierre/diffs core (pure, no DOM) so we KNOW the
 * resolved content is correct before wiring it to files:write-file.
 */
import { describe, it, expect } from 'vitest'
import { buildFileDiff, resolvedContent, applyHunkDecision, hunkRows } from '../../src/renderer/components/chat/fileDiffResolve'

const OLD = 'line1\nline2\nline3\n'
const NEW = 'line1\nCHANGED\nline3\nADDED\n'

describe('fileDiffResolve', () => {
  it('a freshly built diff resolves to the new (agent) content', () => {
    const fd = buildFileDiff('a.txt', OLD, NEW)
    expect(resolvedContent(fd)).toBe(NEW)
  })

  it('rejecting the only hunk resolves back to the old content', () => {
    const fd = buildFileDiff('a.txt', OLD, NEW)
    const rejected = applyHunkDecision(fd, 0, 'reject')
    expect(resolvedContent(rejected)).toBe(OLD)
  })

  it('accepting the only hunk keeps the new content', () => {
    const fd = buildFileDiff('a.txt', OLD, NEW)
    const accepted = applyHunkDecision(fd, 0, 'accept')
    expect(resolvedContent(accepted)).toBe(NEW)
  })

  it('projects a hunk into displayable unified-diff rows', () => {
    const fd = buildFileDiff('a.txt', OLD, NEW)
    const rows = hunkRows(fd, 0)
    expect(rows).toEqual([
      { kind: 'context', text: 'line1', oldLine: 1, newLine: 1 },
      { kind: 'del', text: 'line2', oldLine: 2, newLine: undefined },
      { kind: 'add', text: 'CHANGED', oldLine: undefined, newLine: 2 },
      { kind: 'context', text: 'line3', oldLine: 3, newLine: 3 },
      { kind: 'add', text: 'ADDED', oldLine: undefined, newLine: 4 },
    ])
  })

  it('partial: reject the first hunk, keep the second', () => {
    // 20 lines so the two edits (line 2 and line 19) are far enough apart to
    // form separate hunks (default diff context is 3 lines each side).
    const base = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
    const oldFile = base.join('\n') + '\n'
    const mutated = [...base]
    mutated[1] = 'CHANGED2'
    mutated[18] = 'CHANGED19'
    const newFile = mutated.join('\n') + '\n'

    const fd = buildFileDiff('a.txt', oldFile, newFile)
    expect(fd.hunks.length).toBe(2)
    // Reject hunk 0 → line2 reverts; hunk 1 (line19) stays changed.
    const step1 = applyHunkDecision(fd, 0, 'reject')
    const expected = [...base]
    expected[18] = 'CHANGED19'
    expect(resolvedContent(step1)).toBe(expected.join('\n') + '\n')
  })
})

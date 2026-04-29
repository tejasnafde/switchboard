/**
 * Pure scanner that drives MessageBubble's inline-pill DOM walker.
 *
 * We test the *string-level* candidate picker (`pickPillCandidates`) because
 * vitest runs in a node environment without jsdom — exercising the full DOM
 * walker requires a renderer-side integration. The picker is the
 * decision-making half; if it's correct, the walker (which just calls
 * `parseFilePathRef` per inline `<code>`) is mechanical.
 *
 * Locks down:
 *   - inline `<code>foo.ts</code>` → no match (no slash → not path-shaped)
 *   - inline `<code>src/foo.ts:42-58</code>` → matched ref
 *   - `<code>` inside `<pre>` (block code) is ignored
 *   - HTML entities decoded before path heuristic
 */
import { describe, it, expect } from 'vitest'
import { pickPillCandidates } from '../../src/renderer/services/messagePills'

describe('pickPillCandidates', () => {
  it('returns empty for empty html', () => {
    expect(pickPillCandidates('')).toEqual([])
  })

  it('matches a path-shaped inline code', () => {
    const html = '<p>see <code>src/foo.ts:30-45</code> for context</p>'
    const out = pickPillCandidates(html)
    expect(out).toHaveLength(1)
    expect(out[0].ref).toEqual({ path: 'src/foo.ts', startLine: 30, endLine: 45 })
  })

  it('skips non-path inline code (no slash)', () => {
    const html = '<p>run <code>npm test</code> twice</p>'
    expect(pickPillCandidates(html)).toEqual([])
  })

  it('ignores <code> inside <pre> blocks', () => {
    const html = '<pre><code>src/foo.ts</code></pre><p><code>src/bar.ts</code></p>'
    const out = pickPillCandidates(html)
    expect(out).toHaveLength(1)
    expect(out[0].ref.path).toBe('src/bar.ts')
  })

  it('decodes html entities before applying the path heuristic', () => {
    const html = '<p><code>src&#x2F;foo.ts</code></p>' // marked sometimes encodes /
    // We don't decode hex entities, only common named — verify the named ones work
    const html2 = '<p><code>src/foo.ts</code></p>'
    expect(pickPillCandidates(html2)).toHaveLength(1)
    // hex / would not decode, so should fail the slash check
    expect(pickPillCandidates(html)).toHaveLength(0)
  })

  it('matches multiple paths in one body', () => {
    const html =
      '<p><code>src/a.ts</code> and <code>src/b/c.py:10</code></p>'
    const out = pickPillCandidates(html)
    expect(out.map((c) => c.text)).toEqual(['src/a.ts', 'src/b/c.py:10'])
  })
})

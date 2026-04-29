/**
 * Inline file-pill enhancement for assistant messages.
 *
 * MessageBubble renders markdown via `marked` + `dangerouslySetInnerHTML`.
 * After paint, we walk the resulting DOM looking for inline `<code>`
 * elements (i.e. NOT inside a `<pre>` block) whose text looks like a
 * project-relative file path — and replace them with clickable chips that
 * open the file viewer at the right line range.
 *
 * Existence on disk is verified via a debounced `files:resolve` IPC call
 * so we don't render pills for paths the agent hallucinated; if the path
 * fails resolution the original `<code>` stays as-is.
 *
 * This module exposes the DOM walker (`enhanceFilePills`) plus a pure
 * helper `pickPillCandidates(rootHtml)` that scans the rendered HTML
 * string and returns the inline-code matches — used in tests to lock down
 * the heuristic without spinning up jsdom.
 */
import { parseFilePathRef, type FilePathRef } from '@shared/filePathRef'

export interface PillCandidate {
  text: string
  ref: FilePathRef
}

/**
 * Pure scan: walk a marked()-produced HTML string, return inline-code
 * tokens that parse as repo paths. We deliberately skip anything inside
 * a `<pre>...</pre>` block (those are full code listings, not references).
 *
 * Implementation note: regex on HTML is fragile in general but marked's
 * output is well-formed and we only need to find `<code>foo</code>`
 * outside `<pre>...</pre>` — a small recursive split handles it.
 */
export function pickPillCandidates(html: string): PillCandidate[] {
  if (!html) return []
  // Split on <pre>...</pre> blocks first so we never match inside them.
  const parts: string[] = []
  let cursor = 0
  const preRe = /<pre[\s\S]*?<\/pre>/gi
  let m: RegExpExecArray | null
  while ((m = preRe.exec(html))) {
    parts.push(html.slice(cursor, m.index))
    cursor = m.index + m[0].length
  }
  parts.push(html.slice(cursor))

  const codeRe = /<code(?:\s[^>]*)?>([^<]+)<\/code>/gi
  const out: PillCandidate[] = []
  for (const part of parts) {
    let cm: RegExpExecArray | null
    while ((cm = codeRe.exec(part))) {
      const text = decodeEntities(cm[1])
      const ref = parseFilePathRef(text)
      if (ref) out.push({ text, ref })
    }
  }
  return out
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * Walk a rendered markdown root and replace path-shaped inline `<code>`
 * elements with chip nodes via the supplied factory. The factory receives
 * the parsed FilePathRef and returns the replacement DOM node (kept as a
 * factory so this module stays React-agnostic — actual chip is built in
 * MessageBubble where it has access to the layout-store / event bus).
 *
 * Skips:
 *   - `<code>` children of `<pre>` (block code)
 *   - already-enhanced nodes (data-pill="1") — guards against re-entrancy
 *     since MessageBubble re-runs this on every render via useEffect.
 */
export function enhanceFilePills(
  root: HTMLElement,
  buildChip: (ref: FilePathRef, originalText: string) => HTMLElement,
): void {
  const codes = root.querySelectorAll('code')
  codes.forEach((code) => {
    if (code.closest('pre')) return
    if (code.getAttribute('data-pill') === '1') return
    const text = (code.textContent ?? '').trim()
    const ref = parseFilePathRef(text)
    if (!ref) return
    const chip = buildChip(ref, text)
    chip.setAttribute('data-pill', '1')
    code.replaceWith(chip)
  })
}

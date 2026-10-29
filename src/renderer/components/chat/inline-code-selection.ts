/**
 * A double-click on inline code selects the whole span. The browser's word
 * selection stops at a hyphen, dot or slash, so `migration-gate` or a path
 * would otherwise select only one part. Fenced blocks (`pre > code`) keep the
 * normal word selection.
 */
export function selectInlineCodeOnDoubleClick(target: EventTarget | null, selection: Selection | null): void {
  if (!(target instanceof Element) || !selection) return
  const code = target.closest('code')
  if (!code || code.closest('pre')) return
  const range = code.ownerDocument.createRange()
  range.selectNodeContents(code)
  selection.removeAllRanges()
  selection.addRange(range)
}

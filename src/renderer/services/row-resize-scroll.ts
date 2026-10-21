/**
 * A row that starts above the view changed size: move the scroll by the same
 * amount so the view stays put. A row that grows first makes room in the
 * content, whose height the virtualizer renders later: without it, at the
 * bottom of the list the browser clamps the scroll, the rows under the
 * resized one move down instead, and a live frame at the top edge comes back
 * into view (and swaps again). Returns whether the scroll moved.
 */
export function keepViewOnRowResize(
  container: { scrollTop: number },
  content: { style: { height: string } } | null,
  itemStart: number,
  delta: number,
): boolean {
  if (itemStart >= container.scrollTop) return false
  if (delta > 0 && content) content.style.height = `${parseFloat(content.style.height) + delta}px`
  container.scrollTop += delta
  return true
}

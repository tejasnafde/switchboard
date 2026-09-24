/**
 * What the composer footer drops first when the pane narrows. Wrapping and
 * flex shrink are CSS; this decides what CSS cannot: whether the decorative
 * hint renders at all. The runtime-mode select always uses short labels,
 * because a native select is as wide as its longest option.
 */
export const COMPACT_FOOTER_BELOW_PX = 560

export interface ComposerFooterLayout {
  showHint: boolean
}

export function composerFooterLayout(paneWidthPx: number | null): ComposerFooterLayout {
  const compact = paneWidthPx !== null && paneWidthPx < COMPACT_FOOTER_BELOW_PX
  return { showHint: !compact }
}

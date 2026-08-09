/**
 * What the composer footer drops first when the pane narrows. Wrapping and
 * flex shrink are CSS; this decides the two things CSS cannot: whether the
 * decorative hint renders at all, and whether the runtime-mode select uses
 * its short labels (the long ones set the select's intrinsic width).
 */
export const COMPACT_FOOTER_BELOW_PX = 560

export interface ComposerFooterLayout {
  showHint: boolean
  shortModeLabels: boolean
}

export function composerFooterLayout(paneWidthPx: number | null): ComposerFooterLayout {
  const compact = paneWidthPx !== null && paneWidthPx < COMPACT_FOOTER_BELOW_PX
  return { showHint: !compact, shortModeLabels: compact }
}

/**
 * How the composer footer fits its width. Five controls share one row, in
 * priority order: P1 project (landing only), P2 agent and model, P3 effort,
 * P4 checkout, P5 runtime mode. As the footer narrows, the lower priorities
 * shorten first and then move into the "..." menu. The context meter and the
 * Send button never move, and the row never wraps.
 *
 * The CSS container queries in the footer (the `/footer` max-width variants) apply these
 * steps to the controls inside the footer. The "..." menu is portalled out of
 * the footer, so no container query reaches it: `useContainerTier` reads the
 * same width and this function says which controls the menu lists.
 * `tests/unit/composer-footer-tiers.test.ts` checks the two use the same
 * numbers.
 */

export type FooterPriority = 1 | 2 | 3 | 4 | 5

/** Footer widths (px) below which each step applies. */
export const FOOTER_STEPS = {
  /** P3 to P5 drop their key: "Effort: High" becomes "High". */
  shortLabels: 760,
  /** P2 shows the model only. */
  modelOnly: 680,
  /** P5 moves into the "..." menu. */
  overflowMode: 600,
  /** P4 moves too. */
  overflowCheckout: 480,
  /** P3 moves too, and P1 truncates harder. */
  overflowEffort: 400,
} as const

/** 0 at full width, then one more for each step the width is below. */
export type FooterTier = 0 | 1 | 2 | 3 | 4 | 5

const ORDERED_STEPS = [
  FOOTER_STEPS.shortLabels,
  FOOTER_STEPS.modelOnly,
  FOOTER_STEPS.overflowMode,
  FOOTER_STEPS.overflowCheckout,
  FOOTER_STEPS.overflowEffort,
]

export function footerTier(width: number): FooterTier {
  // An element that is not laid out yet measures 0; treat it as full width
  // rather than collapse every control into the menu for one frame.
  if (!(width > 0)) return 0
  return ORDERED_STEPS.filter((step) => width < step).length as FooterTier
}

/** The priorities the "..." menu holds at this tier, highest first. */
export function overflowedPriorities(tier: FooterTier): FooterPriority[] {
  const moved: FooterPriority[] = []
  if (tier >= 5) moved.push(3)
  if (tier >= 4) moved.push(4)
  if (tier >= 3) moved.push(5)
  return moved
}

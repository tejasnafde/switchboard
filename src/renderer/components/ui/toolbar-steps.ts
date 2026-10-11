/**
 * How a `Toolbar` row fits its width. Each item has a priority, given as the
 * step below which it leaves the row; as the toolbar narrows the lower
 * priorities shorten first and then move into the "..." menu. The row never
 * wraps.
 *
 * The steps are toolbar container widths in px, widest first. In the composer
 * footer: below 760 chip labels shorten (`ChipLabel`), below 680 the agent
 * chip shows the model only, below 600 the runtime mode moves into "...",
 * below 480 the checkout, below 400 the effort.
 *
 * CSS container queries (the `/toolbar` max-width variants) hide the items in
 * the row. The "..." menu is portalled out of the toolbar, so no container
 * query reaches it: `useContainerTier(toolbarTier)` reads the same width and
 * `overflowedItems` says what the menu lists. `tests/unit/toolbar.test.ts`
 * keeps the classes on these steps.
 */
export const TOOLBAR_STEPS = [760, 680, 600, 480, 400] as const

export type ToolbarStep = (typeof TOOLBAR_STEPS)[number]

/** 0 at full width, then one more for each step the width is below. */
export function toolbarTier(width: number): number {
  // An element that is not laid out yet measures 0; treat it as full width
  // rather than collapse every item into the menu for one frame.
  if (!(width > 0)) return 0
  return TOOLBAR_STEPS.filter((step) => width < step).length
}

/** The items that left the row at this tier, in the order given. */
export function overflowedItems<T extends { hideBelow: ToolbarStep }>(items: readonly T[], tier: number): T[] {
  return items.filter((item) => TOOLBAR_STEPS.indexOf(item.hideBelow) < tier)
}

/**
 * cmd+shift+O goes to the landing screen from a chat and opens its project
 * picker once the landing screen shows, so a new chat may take two presses.
 * Resolves with the picker's search box focused and the current project
 * highlighted: type to filter, Enter to pick.
 */
export async function openLandingProjectPicker(win) {
  const search = win.getByPlaceholder('Find a project…')
  await win.keyboard.press('Meta+Shift+O')
  await win.getByTestId('chat-landing').waitFor({ timeout: 5000 })
  if (!(await search.isVisible())) await win.keyboard.press('Meta+Shift+O')
  await search.waitFor({ timeout: 5000 })
  await win.getByRole('option').first().waitFor({ timeout: 5000 })
}

/**
 * Pick `value` from a composer footer chip (a chip that opens a list, where a
 * native <select> used to be): click the chip, then the row for `value`.
 */
export async function pickChipOption(win, chip, value) {
  await chip.click()
  const row = win.locator(`[role="listbox"] [role="option"][data-value="${value}"]`)
  await row.waitFor({ timeout: 5000 })
  await row.click()
  await row.waitFor({ state: 'detached', timeout: 5000 })
}

/** How many rows a composer footer chip's list offers. Leaves it closed. */
export async function countChipOptions(win, chip) {
  await chip.click()
  const rows = win.locator('[role="listbox"] [role="option"]')
  await rows.first().waitFor({ timeout: 5000 })
  const count = await rows.count()
  await win.keyboard.press('Escape')
  await rows.first().waitFor({ state: 'detached', timeout: 5000 })
  return count
}

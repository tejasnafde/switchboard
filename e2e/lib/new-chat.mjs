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

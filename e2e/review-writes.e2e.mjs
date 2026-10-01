/**
 * Reviews writes, against the built app (npm run build:fast) with the demo
 * adapter and an isolated profile. The demo provider records every write on
 * `globalThis.__sbDemoPrWrites` in the main process instead of sending it, so
 * nothing here reaches GitHub or Bitbucket.
 *
 * #161 (you review it): reply to a thread, resolve it, drag a line range
 * both ways (Escape cancels), hold still at the edge to scroll, hold a line comment,
 * then submit an approving review with it. #159 (yours, nothing blocks it):
 * no Review offered, the strategy menu lists merge commit first, the merge
 * asks through the confirm dialog naming branch and strategy, Cancel sends
 * nothing, Merge sends a merge commit with the head. #612 (yours, blocked,
 * Bitbucket): Merge is disabled and Checks says why there is no Re-run; its
 * merge conflicts show once in each place; with a slow demo host, a reviewer
 * is added from the combobox (recent reviewers while the members load, the
 * popover closing on the pick, a pending row, the box usable again before the
 * list refresh ends) and another removed from the row menu; By repository groups and
 * folds the list; #88 is hidden, shown and restored; #612 is declined after
 * the confirm (Cancel sends nothing).
 * Temp dirs are removed. SB_SHOTS=<dir> also saves the review form, the
 * strategy menu and the merge confirm there, to look at by eye.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-review-writes-ud-')

const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SHELL: '/bin/sh' } })
const win = await app.firstWindow({ timeout: 20_000 })
await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
await win.evaluate(() => Promise.all([
  window.api.settings.set('tour.autoplay', 'false'),
  window.api.settings.set('analytics.enabled', 'false'),
  window.api.settings.set('analytics.noticeSeen', 'true'),
]))
const skip = win.getByRole('button', { name: 'Skip tour' })
if (await skip.isVisible().catch(() => false)) await skip.click()

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const writes = () => app.evaluate(() => globalThis.__sbDemoPrWrites ?? [])
const shot = async (name) => { if (process.env.SB_SHOTS) await win.screenshot({ path: join(process.env.SB_SHOTS, `${name}.png`) }) }
const reviews = () => win.locator('[data-reviews-view]')
const header = () => reviews().locator('header')

async function openPr(number) {
  await reviews().locator(`[data-pr-row$="#${number}"]`).click()
  await reviews().locator(`[data-pr-row$="#${number}"][aria-current="true"]`).waitFor({ state: 'visible' })
}

try {
  await win.getByRole('button', { name: 'Reviews', exact: true }).click()
  await reviews().locator('[data-pr-row]').first().waitFor({ state: 'visible', timeout: 20_000 })

  // ── #161: reply, resolve, a held line comment, an approving review ──
  await openPr(161)
  await header().locator('[data-review-button]').waitFor({ state: 'visible', timeout: 20_000 })
  check('a PR you review offers Review, not Merge', await header().locator('[data-merge-button]').count() === 0)
  await reviews().getByRole('tab', { name: /^Files/ }).click()
  const thread = reviews().locator('[data-pr-thread="s1"]')
  await thread.waitFor({ state: 'visible', timeout: 20_000 })
  await thread.getByPlaceholder('Reply').fill('On purpose: 0 means no cap.')
  await thread.getByRole('button', { name: 'Reply', exact: true }).click()
  await thread.locator('p', { hasText: 'On purpose: 0 means no cap.' }).waitFor({ state: 'visible', timeout: 10_000 })
  const reply = (await writes()).find((w) => w.action === 'reply')
  check('reply is recorded, not sent', reply?.input?.conversationId === 's1' && reply?.input?.body === 'On purpose: 0 means no cap.', JSON.stringify(reply))
  check('the reply box empties after it posts', (await thread.getByPlaceholder('Reply').inputValue()) === '')

  await thread.getByRole('button', { name: 'Resolve', exact: true }).click()
  await thread.getByRole('button', { name: 'Unresolve', exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  const resolve = (await writes()).find((w) => w.action === 'resolve')
  check('resolve is recorded and the thread shows it', resolve?.input?.conversationId === 's1', JSON.stringify(resolve))

  // Drag over the new-side numbers: 85 down to 87 selects three rows, 88 up to
  // 85 four; Escape mid-drag puts back what was there.
  const gutter = (n) => reviews().locator(`[data-new-line="${n}"] > :nth-child(2)`)
  const centre = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
  const dragFrom = async (from, to) => {
    await win.mouse.move(...(await centre(gutter(from))))
    await win.mouse.down()
    await win.mouse.move(...(await centre(gutter(to))), { steps: 6 })
  }
  const selectedRows = () => reviews().locator('[data-diff-hunk][aria-selected="true"]').count()
  await dragFrom(85, 87)
  await win.mouse.up()
  check('a drag down selects the lines it crossed', await selectedRows() === 3, String(await selectedRows()))
  await dragFrom(88, 85)
  await win.mouse.up()
  check('a drag up selects the lines it crossed', await selectedRows() === 4, String(await selectedRows()))
  await dragFrom(86, 87)
  await win.keyboard.press('Escape')
  await win.mouse.up()
  check('Escape cancels a drag and keeps the previous selection', await selectedRows() === 4, String(await selectedRows()))

  // Holding still near the bottom edge keeps scrolling and grows the range. The demo file is
  // short, so the pane is capped to make it scroll, and put back afterwards.
  const pane = reviews().locator('[data-pr-diff]').locator('..')
  await pane.evaluate((el) => { el.style.maxHeight = '130px'; el.scrollTop = 0 })
  await win.mouse.move(...(await centre(gutter(84))))
  await win.mouse.down()
  const paneBox = await pane.boundingBox()
  await win.mouse.move((await centre(gutter(84)))[0], paneBox.y + paneBox.height - 4, { steps: 4 })
  const heldAt = await pane.evaluate((el) => el.scrollTop)
  const heldRows = await selectedRows()
  await win.waitForTimeout(600)
  const scrolled = await pane.evaluate((el) => el.scrollTop)
  const grown = await selectedRows()
  check('holding still at the bottom edge keeps scrolling', scrolled > heldAt, `${heldAt} -> ${scrolled}`)
  check('the range grows while it scrolls', grown > heldRows, `${heldRows} -> ${grown}`)
  await win.mouse.up()
  const after = await pane.evaluate((el) => el.scrollTop)
  await win.waitForTimeout(300)
  check('releasing stops the scroll', await pane.evaluate((el) => el.scrollTop) === after)
  await pane.evaluate((el) => { el.style.maxHeight = ''; el.scrollTop = 0 })

  // Select new line 87 by its number, Comment, hold it for the review.
  await reviews().getByRole('button', { name: 'Select line 87' }).last().click()
  await reviews().getByRole('button', { name: 'Comment', exact: true }).click()
  await reviews().getByLabel('Comment on line 87').fill('Clamp negatives here too.')
  // A drag cancelled with Escape leaves the open comment box and its text alone.
  await dragFrom(85, 86)
  check('the comment box stays open during a drag', await reviews().getByLabel('Comment on line 87').isVisible())
  await win.keyboard.press('Escape')
  await win.mouse.up()
  check('Escape keeps the comment box and its text', (await reviews().getByLabel('Comment on line 87').inputValue()) === 'Clamp negatives here too.')
  await shot('line-comment')
  await reviews().getByRole('button', { name: 'Add to review' }).click()
  await reviews().locator('[data-pending-comment]').waitFor({ state: 'visible' })
  const bar = reviews().locator('[data-pending-review]')
  check('the held comment shows in the diff and the pending bar', (await bar.innerText()).includes('Your pending review: 1 comment'))
  check('holding a comment sends nothing', !(await writes()).some((w) => w.action === 'inline-comment' || w.action === 'submit-review'))

  await header().locator('[data-review-button]').getByRole('button', { name: 'Review', exact: true }).click()
  const form = win.locator('[data-review-form]')
  await form.waitFor({ state: 'visible' })
  check('the review form lists the pending comment', (await form.innerText()).includes('src/main/db/kanban.ts:87'))
  check('a reviewer is offered Approve and Request changes', await form.getByLabel('Approve').isVisible() && await form.getByLabel('Request changes').isVisible())
  await form.getByLabel('Approve').check()
  await form.getByLabel('Review summary').fill('Looks good with the one note.')
  await shot('review-form')
  await form.getByRole('button', { name: 'Submit review' }).click()
  await form.waitFor({ state: 'hidden', timeout: 10_000 })
  const review = (await writes()).find((w) => w.action === 'submit-review')
  check('the review is recorded with its verdict, summary and comment',
    review?.input?.event === 'approve' && review?.input?.body === 'Looks good with the one note.'
      && review?.input?.comments?.length === 1 && review.input.comments[0].line === 87 && review.input.comments[0].side === 'new',
    JSON.stringify(review))
  await bar.waitFor({ state: 'hidden', timeout: 10_000 })
  check('the posted comment leaves the pending review', await reviews().locator('[data-pending-comment]').count() === 0)

  // ── #159: your PR, nothing blocks it ──
  await openPr(159)
  const merge = header().locator('[data-merge-button]')
  await merge.getByRole('button', { name: 'Merge', exact: true }).and(win.locator(':enabled')).waitFor({ state: 'visible', timeout: 20_000 })
  check('your own PR never offers Review (so never Approve)', await header().locator('[data-review-button]').count() === 0)
  await merge.getByRole('button', { name: 'Merge strategy' }).click()
  const menu = win.getByRole('menu', { name: 'Merge strategy' })
  await menu.waitFor({ state: 'visible' })
  const items = await menu.getByRole('menuitemradio').allInnerTexts()
  const checked = await menu.locator('[aria-checked="true"]').innerText()
  await shot('merge-menu')
  check('the strategy menu lists what the repository allows, merge commit first and chosen', items.join('|') === 'Merge commit|Squash|Rebase' && checked === 'Merge commit', items.join('|'))
  await win.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })

  await merge.getByRole('button', { name: 'Merge', exact: true }).click()
  const dialog = win.getByRole('alertdialog', { name: 'Merge #159 into main?' })
  await dialog.waitFor({ state: 'visible' })
  await shot('merge-confirm')
  check('the confirm names the target branch and the strategy', (await dialog.innerText()).includes('into main on GitHub. Strategy: merge commit.'))
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  check('Cancel sends nothing', !(await writes()).some((w) => w.action === 'merge'))

  await merge.getByRole('button', { name: 'Merge', exact: true }).click()
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: 'Merge', exact: true }).click()
  await merge.waitFor({ state: 'hidden', timeout: 10_000 })
  const merged = (await writes()).find((w) => w.action === 'merge')
  check('the merge is recorded as a merge commit on the confirmed head', merged?.ref?.number === 159 && merged?.input?.strategy === 'merge_commit' && merged?.input?.headSha === 'a1b2c3d', JSON.stringify(merged))
  check('the merged PR moves to Merged', await reviews().locator('[data-pr-group="merged"] [data-pr-row$="#159"]').isVisible())

  // ── #612: yours, blocked, on Bitbucket ──
  await openPr(612)
  const blocked = header().locator('[data-merge-button]').getByRole('button', { name: 'Merge', exact: true })
  await blocked.waitFor({ state: 'visible', timeout: 20_000 })
  check('a blocked PR keeps Merge in place, disabled', await blocked.isDisabled() && (await blocked.getAttribute('title'))?.startsWith('Blocked: '))
  await reviews().getByRole('tab', { name: /^Checks/ }).click()
  await reviews().locator('[data-rerun-unavailable]').waitFor({ state: 'visible', timeout: 10_000 })
  check('Bitbucket shows why there is no Re-run', (await reviews().locator('[data-rerun-unavailable]').innerText()).includes("Bitbucket's API cannot re-run")
    && await reviews().getByRole('button', { name: /^Re-run / }).count() === 0)

  // ── #612: conflicts, one mention in each place ──
  check('the row says merge conflicts', (await reviews().locator('[data-pr-row$="#612"]').innerText()).includes('merge conflicts'))
  check('the header counts the conflicted files', (await header().locator('[data-pr-conflicts]').innerText()) === 'Conflicts with main in 2 files')
  await reviews().getByRole('tab', { name: 'Overview' }).click()
  const callout = reviews().locator('[data-pr-conflict-callout]')
  await callout.waitFor({ state: 'visible', timeout: 10_000 })
  const calloutText = await callout.innerText()
  check('the callout names the files', calloutText.includes('sync/worker.py') && calloutText.includes('sync/config.py'), calloutText)
  check('the Merge card lists the conflict blocker', await reviews().getByText('Conflicts with main', { exact: true }).isVisible())
  await reviews().getByRole('tab', { name: /^Files/ }).click()
  await reviews().locator('[data-file-conflict]').first().waitFor({ state: 'visible', timeout: 10_000 })
  check('the Files tree marks both conflicted files', await reviews().locator('[data-file-conflict]').count() === 2)

  // ── #612: add a reviewer with a slow host, remove one ──
  // A reload drops the candidates the Overview already read, so the slow read is seen from the start.
  await app.evaluate(() => { globalThis.__sbDemoPrDelayMs = { candidates: 2_500, write: 1_500, list: 6_000 } })
  await win.reload()
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.getByRole('button', { name: 'Reviews', exact: true }).click()
  await reviews().locator('[data-pr-row]').first().waitFor({ state: 'visible', timeout: 20_000 })
  await openPr(612)
  const addBox = reviews().getByRole('combobox', { name: 'Add reviewer' })
  await addBox.click()
  const search = win.getByPlaceholder('Find a person')
  await search.waitFor({ state: 'visible' })
  check('while the members load, the box offers the repository\'s recent reviewers', await win.getByRole('option', { name: /backend/ }).isVisible())
  await search.fill('bar')
  check('the search is usable during the load and says it is loading', await search.isEnabled() && (await win.locator('[cmdk-empty]').innerText()) === 'Loading…')
  await win.getByRole('option', { name: /barath/ }).waitFor({ state: 'visible', timeout: 15_000 })
  await win.getByRole('option', { name: /barath/ }).click()
  const picked = Date.now()
  const pendingRow = reviews().locator('[data-pr-reviewer-pending="barath"]')
  await pendingRow.waitFor({ state: 'visible', timeout: 1_000 })
  check('a pick closes the popover at once', !(await search.isVisible()))
  check('the pending row says it is adding them', (await pendingRow.innerText()).includes('Adding…'))
  await reviews().locator('[data-pr-reviewer="barath"]').waitFor({ state: 'visible', timeout: 10_000 })
  await addBox.and(win.locator(':enabled')).waitFor({ state: 'visible', timeout: 10_000 })
  const usable = Date.now() - picked
  check('the box is usable again once the write and the PR re-read are done, not the whole list', usable < 5_000 && await pendingRow.count() === 0, `${usable}ms`)
  const added = (await writes()).find((w) => w.action === 'add-reviewer')
  check('Add reviewer sends the Bitbucket account uuid', added?.input?.reviewer === '{00000000-0000-4000-8000-000000000005}', JSON.stringify(added))
  await reviews().locator('[data-pr-reviewer="pankaj"]').hover()
  await reviews().getByRole('button', { name: 'Actions for pankaj' }).click()
  await win.getByRole('menuitem', { name: 'Remove reviewer' }).click()
  await reviews().locator('[data-pr-reviewer="pankaj"]').getByText('Removing…').waitFor({ state: 'visible', timeout: 1_000 })
  await reviews().locator('[data-pr-reviewer="pankaj"]').waitFor({ state: 'hidden', timeout: 10_000 })
  check('Remove reviewer shows Removing, then takes them off the card', true)
  await app.evaluate(() => { globalThis.__sbDemoPrDelayMs = undefined })

  // ── By repository ──
  await reviews().getByRole('button', { name: 'By repository', exact: true }).click()
  const botSection = reviews().locator('[data-pr-repo="bitbucket:geoiq/ssg-bot-v2"]')
  await botSection.waitFor({ state: 'visible' })
  check('By repository draws one section per repository', await reviews().locator('[data-pr-repo]').count() === 4)
  await botSection.getByRole('button', { expanded: true }).click()
  await botSection.locator('[data-pr-row]').waitFor({ state: 'hidden' })
  check('a folded repository keeps its count', (await botSection.innerText()).includes('1'))
  check('the grouping and the fold are saved', await win.evaluate(() => window.api.settings.get('reviews.groupBy')) === 'repository'
    && (await win.evaluate(() => window.api.settings.get('reviews.collapsedRepos'))).includes('ssg-bot-v2'))
  await botSection.getByRole('button', { expanded: false }).click()
  await reviews().getByRole('button', { name: 'By status', exact: true }).click()
  await reviews().locator('[data-pr-group]').first().waitFor({ state: 'visible' })

  // ── #88: hide, show, restore ──
  await openPr(88)
  await header().getByRole('button', { name: 'More actions' }).click()
  await win.getByRole('menuitem', { name: /^Hide from Reviews/ }).click()
  const hiddenRow = reviews().locator('[data-pr-hidden-row]')
  await hiddenRow.waitFor({ state: 'visible', timeout: 10_000 })
  check('a hidden PR leaves the list and is counted', (await hiddenRow.innerText()).startsWith('1 hidden') && await reviews().locator('[data-pr-row$="#88"]').count() === 0)
  await hiddenRow.getByRole('button', { name: 'Show' }).click()
  await reviews().locator('[data-pr-row$="#88"]').waitFor({ state: 'visible' })
  check('Show lists it again, marked hidden', (await reviews().locator('[data-pr-row$="#88"]').innerText()).includes('hidden'))
  await header().getByRole('button', { name: 'More actions' }).click()
  await win.getByRole('menuitem', { name: /^Show in Reviews/ }).click()
  await hiddenRow.waitFor({ state: 'hidden', timeout: 10_000 })
  check('Show in Reviews restores it', true)
  check('hiding sends nothing to the host', !(await writes()).some((w) => /hide/.test(w.action)))

  // ── #161 is not yours: no Close ──
  await openPr(161)
  await header().getByRole('button', { name: 'More actions' }).click()
  check('a PR you may not manage offers no Close', await win.getByRole('menuitem', { name: /Close pull request/ }).count() === 0)
  await win.keyboard.press('Escape')

  // ── #612: decline, after the confirm ──
  await openPr(612)
  await header().locator('[data-merge-button]').waitFor({ state: 'visible', timeout: 20_000 })
  const declineItem = async () => {
    await header().getByRole('button', { name: 'More actions' }).click()
    await win.getByRole('menuitem', { name: /^Decline pull request/ }).click()
  }
  await declineItem()
  const declineDialog = win.getByRole('alertdialog', { name: 'Decline #612?' })
  await declineDialog.waitFor({ state: 'visible' })
  await shot('decline-confirm')
  check('the decline confirm names the PR and says it is for everyone', (await declineDialog.innerText()).includes('"Jittered backoff for the SSG sync worker" is declined on Bitbucket for everyone'))
  await declineDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await declineDialog.waitFor({ state: 'hidden' })
  check('Cancel declines nothing', !(await writes()).some((w) => w.action === 'decline'))
  await declineItem()
  await declineDialog.getByRole('button', { name: 'Decline', exact: true }).click()
  await reviews().locator('[data-pr-row$="#612"]').waitFor({ state: 'hidden', timeout: 10_000 })
  check('a declined PR leaves the list', true)

  check('only the expected writes were recorded', (await writes()).map((w) => w.action).join(',') === 'reply,resolve,submit-review,merge,add-reviewer,remove-reviewer,decline', (await writes()).map((w) => w.action).join(','))
} catch (err) {
  console.error(err)
  results.push({ ok: false })
} finally {
  await app.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 && results.length > 0 ? 0 : 1)

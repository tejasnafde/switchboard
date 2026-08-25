#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareElectronTestRuntime } from './electron-runtime.mjs'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build first')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'sb-dual-chat-e2e-'))
const userDataDir = join(root, 'user-data')
const isolatedHome = join(root, 'home')
const isolatedTmp = join(root, 'tmp')
const projectA = join(root, 'project-a')
const projectB = join(root, 'project-b')
for (const dir of [userDataDir, isolatedHome, isolatedTmp, projectA, projectB]) {
  mkdirSync(dir, { recursive: true })
}

let runtime
let app
const cleanup = () => {
  try { runtime?.cleanup() } catch { /* best effort */ }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
}
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function assert(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`✓ ${message}`)
}

async function selectSidebarSession(win, title, sessionId) {
  const projectThread = win.locator('.sidebar-thread-main', { hasText: title })
  if (await projectThread.count() > 0 && await projectThread.first().isVisible()) {
    await projectThread.first().click()
  } else {
    const recent = win.locator('.sidebar-recent-row', { hasText: title }).first()
    for (let reveal = 0; reveal < 5 && await recent.count() === 0; reveal++) {
      const showMore = win.locator('.sidebar-recents-more', { hasText: 'Show' }).first()
      if (await showMore.count() === 0) break
      await showMore.click()
    }
    await recent.click()
  }
  await win.locator(`[data-chat-slot="primary"][data-session-id="${sessionId}"]`).waitFor()
}

async function emitProviderEvents(events) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!main) throw new Error('Switchboard BrowserWindow not found')
    for (const event of payload) main.webContents.send('provider:event', event)
  }, events)
}

try {
  runtime = await prepareElectronTestRuntime({ repoRoot, tempRoot: isolatedTmp })
  const launchEnv = {
    ...process.env,
    HOME: isolatedHome,
    TMPDIR: `${isolatedTmp}/`,
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
  for (const key of Object.keys(launchEnv)) {
    if (/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENCODE_|CLAUDE_CONFIG_DIR|CODEX_HOME)/.test(key)) {
      delete launchEnv[key]
    }
  }

  app = await electron.launch({
    args: [runtime.appPath, `--user-data-dir=${userDataDir}`],
    cwd: runtime.appPath,
    env: launchEnv,
  })
  const win = await app.firstWindow()
  win.on('pageerror', (error) => console.error('[renderer pageerror]', error))
  await win.waitForFunction(() => Boolean(window.api?.app?.createConversation), null, { timeout: 20_000 })

  const seededProjects = await win.evaluate(async ({ projectAPath, projectBPath }) => {
    await window.api.settings.set('tour.autoplay', 'false')
    await window.api.routing.invokeOn('local', 'app:add-project-path', projectAPath)
    await window.api.routing.invokeOn('local', 'app:add-project-path', projectBPath)
    await window.api.app.createConversation({ id: 'dual-a', projectPath: projectAPath, agentType: 'claude-code', title: 'Dual A' })
    await window.api.app.createConversation({ id: 'dual-b', projectPath: projectBPath, agentType: 'codex', title: 'Dual B' })
    await window.api.app.createConversation({ id: 'idle-feedback', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Feedback' })
    await window.api.app.createConversation({ id: 'idle-rollback', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Rollback' })
    await window.api.app.createConversation({ id: 'idle-collision', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Collision' })
    await window.api.app.createConversation({ id: 'idle-ambiguous', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Ambiguous' })
    await window.api.app.createConversation({ id: 'idle-acceptance-race', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Acceptance Race' })
    await window.api.app.createConversation({ id: 'idle-resolution-failure', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Resolution Failure' })
    await window.api.app.createConversation({ id: 'idle-resolution-not-found', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Resolution Not Found' })
    await window.api.app.createConversation({ id: 'idle-edited-ambiguous', projectPath: projectAPath, agentType: 'claude-code', title: 'Idle Edited Ambiguous' })
    await window.api.app.createConversation({ id: 'tall-history', projectPath: projectAPath, agentType: 'claude-code', title: 'Tall History' })
    await window.api.app.saveMessage({ id: 'seed-a', conversationId: 'dual-a', role: 'assistant', content: 'Seed response from A' })
    await window.api.app.saveMessage({ id: 'seed-b', conversationId: 'dual-b', role: 'assistant', content: 'Seed response from B' })
    const paragraph = Array.from({ length: 18 }, (_, index) => `wrapped line ${index + 1}: a dynamically measured transcript must reserve the full rendered height`).join('\n')
    for (let index = 0; index < 30; index++) {
      await window.api.app.saveMessage({
        id: `tall-${index}`,
        conversationId: 'tall-history',
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Tall turn ${index + 1}\n${paragraph}`,
      })
    }
    return window.api.app.getProjects()
  }, { projectAPath: projectA, projectBPath: projectB })
  assert(seededProjects.some((project) => project.sessions.some((session) => session.id === 'dual-a')), 'isolated backend catalogues session A')
  assert(seededProjects.some((project) => project.sessions.some((session) => session.id === 'dual-b')), 'isolated backend catalogues session B')

  await win.reload()
  await win.waitForFunction(() => Boolean(window.api?.app?.loadSessionById), null, { timeout: 20_000 })
  await win.keyboard.press('Escape')
  const reloadedProjects = await win.evaluate(() => window.api.app.getProjects())
  assert(reloadedProjects.some((project) => project.sessions.some((session) => session.id === 'dual-a')), 'session A survives renderer reload')
  assert(reloadedProjects.some((project) => project.sessions.some((session) => session.id === 'dual-b')), 'session B survives renderer reload')
  try {
    await win.locator('.sidebar-recent-row', { hasText: 'Dual A' }).waitFor({ timeout: 20_000 })
  } catch (error) {
    console.error('renderer body after sidebar timeout', (await win.locator('body').innerText()).slice(0, 4_000))
    throw error
  }

  // A cold idle send must acknowledge the click before provider startup
  // finishes. Stub only this renderer's provider boundary: the accepted
  // result deliberately arrives without a canonical event, exercising the
  // authoritative-result fallback as well as the pending presentation.
  await selectSidebarSession(win, 'Idle Feedback', 'idle-feedback')
  const idlePanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-feedback"]')
  const providerStubbed = await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.__sbIdleRollbackOrigins = []
    globalThis.__sbIdleAmbiguousOrigins = []
    globalThis.__sbIdleEditedAmbiguousOrigins = []
    globalThis.__sbIdleResolutionFailureOrigins = []
    globalThis.__sbIdleResolutionNotFoundOrigins = []
    globalThis.__sbIdleEditedRecoveryResolved = false
    globalThis.__sbIdleEditedRecoveryOrder = []
    ipcMain.removeHandler('provider:start-session')
    ipcMain.handle('provider:start-session', async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    ipcMain.removeHandler('provider:submit-user-turn')
    ipcMain.handle('provider:submit-user-turn', async (_event, turn) => {
      if (turn.threadId === 'idle-rollback') {
        globalThis.__sbIdleRollbackOrigins.push(turn.origin)
        if (globalThis.__sbIdleRollbackOrigins.length === 1) {
          return {
            status: 'rejected',
            accepted: false,
            duplicate: false,
            state: 'rejected',
            retryable: true,
            reason: 'Fixture rejected the first delivery',
          }
        }
      }
      if (turn.threadId === 'idle-collision') {
        return {
          status: 'rejected',
          accepted: false,
          duplicate: false,
          state: 'rejected',
          retryable: true,
          reason: 'Fixture rejected the colliding delivery',
        }
      }
      if (turn.threadId === 'idle-ambiguous') {
        globalThis.__sbIdleAmbiguousOrigins.push(turn.origin)
        if (globalThis.__sbIdleAmbiguousOrigins.length === 1) {
          return {
            status: 'ambiguous',
            accepted: false,
            duplicate: false,
            state: 'ambiguous',
            reason: 'Fixture could not confirm delivery',
          }
        }
      }
      if (turn.threadId === 'idle-acceptance-race') {
        const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
        setTimeout(() => main?.webContents.send('provider:event', {
          type: 'user.message',
          threadId: turn.threadId,
          origin: turn.origin,
          text: turn.providerText,
          at: Date.now(),
        }), 0)
        return {
          status: 'ambiguous',
          accepted: false,
          duplicate: false,
          state: 'ambiguous',
          reason: 'Fixture races acceptance against the ambiguous response',
        }
      }
      if (turn.threadId === 'idle-resolution-failure') {
        globalThis.__sbIdleResolutionFailureOrigins.push(turn.origin)
        if (globalThis.__sbIdleResolutionFailureOrigins.length === 1) {
          return {
            status: 'ambiguous',
            accepted: false,
            duplicate: false,
            state: 'ambiguous',
            reason: 'Fixture leaves the original delivery ambiguous',
          }
        }
      }
      if (turn.threadId === 'idle-resolution-not-found') {
        globalThis.__sbIdleResolutionNotFoundOrigins.push(turn.origin)
        if (globalThis.__sbIdleResolutionNotFoundOrigins.length === 1) {
          return {
            status: 'ambiguous',
            accepted: false,
            duplicate: false,
            state: 'ambiguous',
            reason: 'Fixture has no durable row for the first delivery',
          }
        }
      }
      if (turn.threadId === 'idle-edited-ambiguous') {
        globalThis.__sbIdleEditedAmbiguousOrigins.push(turn.origin)
        globalThis.__sbIdleEditedRecoveryOrder.push(`submit:${turn.origin}`)
        if (globalThis.__sbIdleEditedAmbiguousOrigins.length === 1) {
          return {
            status: 'ambiguous',
            accepted: false,
            duplicate: false,
            state: 'ambiguous',
            reason: 'Fixture could not confirm edited delivery',
          }
        }
        if (globalThis.__sbIdleEditedRecoveryResolved
          && turn.origin === globalThis.__sbIdleEditedAmbiguousOrigins[0]) {
          const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
          main?.webContents.send('provider:event', {
            type: 'user.message',
            threadId: turn.threadId,
            origin: turn.origin,
            text: 'Ambiguous message before edit',
            at: Date.now(),
          })
        }
        if (!globalThis.__sbIdleEditedRecoveryResolved) {
          return {
            status: 'rejected',
            accepted: false,
            duplicate: false,
            state: 'rejected',
            retryable: true,
            reason: 'Earlier ambiguous delivery blocks this turn',
            blockingOrigin: globalThis.__sbIdleEditedAmbiguousOrigins[0],
          }
        }
      }
      return {
        status: 'accepted',
        accepted: true,
        duplicate: false,
        state: 'completed',
        acceptedAt: Date.now(),
      }
    })
    ipcMain.removeHandler('provider:resolve-user-turn')
    ipcMain.handle('provider:resolve-user-turn', async (_event, resolution) => {
      if (resolution.threadId === 'idle-resolution-failure') {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return { status: 'pending', reason: 'Fixture could not resolve the earlier delivery' }
      }
      if (resolution.threadId === 'idle-resolution-not-found') {
        return { status: 'not_found', reason: 'No matching turn delivery was found' }
      }
      globalThis.__sbIdleEditedRecoveryResolved = true
      globalThis.__sbIdleEditedRecoveryOrder.push(`resolve:${resolution.origin}`)
      return { status: 'completed', changed: false }
    })
    return true
  })
  assert(providerStubbed, 'idle-send fixture installs a delayed provider boundary')
  const idleComposer = idlePanel.getByLabel('Chat message')
  await idleComposer.fill('Cold idle feedback check')
  await idleComposer.press('Enter')
  const idleSending = idlePanel.getByText('Sending…', { exact: true }).first()
  await idleSending.waitFor({ timeout: 700 })
  assert(
    !(await idleComposer.textContent())?.includes('Cold idle feedback check'),
    'cold idle send clears the composer before provider acceptance',
  )
  await idleSending.waitFor({ state: 'detached', timeout: 2_000 })
  assert(!(await idleComposer.textContent())?.includes('Cold idle feedback check'), 'accepted idle send clears the draft')
  assert(await idlePanel.getByText('Cold idle feedback check').count() === 1, 'accepted idle send keeps one reconciled bubble')

  await selectSidebarSession(win, 'Idle Rollback', 'idle-rollback')
  const rollbackPanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-rollback"]')
  const rollbackComposer = rollbackPanel.getByLabel('Chat message')
  await rollbackComposer.fill('Restore this failed idle send')
  await rollbackComposer.press('Enter')
  assert(
    !(await rollbackComposer.textContent())?.includes('Restore this failed idle send'),
    'failed idle send clears the composer while delivery is pending',
  )
  await rollbackPanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  assert(
    (await rollbackComposer.textContent())?.includes('Restore this failed idle send'),
    'definite delivery failure restores the exact draft',
  )
  assert(
    await rollbackPanel.locator('.chat-composer button', { hasText: 'Retry' }).count() === 1,
    'restored failed delivery exposes a Retry action',
  )
  assert(
    await rollbackPanel.locator('[data-message-list-scroll]').getByText('Restore this failed idle send').count() === 0,
    'failed optimistic bubble is removed from the transcript',
  )
  await rollbackPanel.locator('.chat-composer button', { hasText: 'Retry' }).click()
  await rollbackPanel.locator('[data-composer-send-error]').waitFor({ state: 'detached', timeout: 2_000 })
  assert(
    await rollbackPanel.locator('[data-message-list-scroll]').getByText('Restore this failed idle send').count() === 1,
    'retry commits one accepted bubble',
  )
  const rollbackOrigins = await app.evaluate(() => globalThis.__sbIdleRollbackOrigins)
  assert(
    rollbackOrigins.length === 2 && rollbackOrigins[0] === rollbackOrigins[1],
    'unchanged retry reuses the original delivery id',
  )

  await selectSidebarSession(win, 'Idle Collision', 'idle-collision')
  const collisionPanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-collision"]')
  const collisionComposer = collisionPanel.getByLabel('Chat message')
  await collisionComposer.fill('Failed message waiting for rollback')
  await collisionComposer.press('Enter')
  await collisionPanel.getByText('Sending…', { exact: true }).first().waitFor({ timeout: 700 })
  await collisionComposer.fill('New draft typed while sending')
  await collisionPanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  assert(
    (await collisionComposer.textContent())?.includes('New draft typed while sending'),
    'delivery rollback never overwrites a newer draft',
  )
  assert(
    !(await collisionComposer.textContent())?.includes('Failed message waiting for rollback'),
    'detached failed payload stays outside the newer composer',
  )
  assert(
    await collisionPanel.locator('[data-composer-recovery] button', { hasText: 'Restore' }).count() === 1,
    'colliding rollback exposes an explicit Restore action',
  )
  let discardWarningCount = 0
  const acceptDiscardWarning = async (dialog) => {
    discardWarningCount += 1
    await dialog.accept()
  }
  win.on('dialog', acceptDiscardWarning)
  await collisionComposer.press('Enter')
  await collisionPanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  win.off('dialog', acceptDiscardWarning)
  assert(discardWarningCount === 1, 'newer draft requires confirmation before discarding a failed payload')
  await collisionComposer.fill('Corrected auto-restored failure')
  let unexpectedRestoredWarning = false
  const dismissUnexpectedRestoredWarning = async (dialog) => {
    unexpectedRestoredWarning = true
    await dialog.dismiss()
  }
  win.on('dialog', dismissUnexpectedRestoredWarning)
  await collisionComposer.press('Enter')
  await win.waitForTimeout(250)
  win.off('dialog', dismissUnexpectedRestoredWarning)
  assert(!unexpectedRestoredWarning, 'editing an auto-restored definite failure sends without a false discard warning')

  await selectSidebarSession(win, 'Idle Acceptance Race', 'idle-acceptance-race')
  const racePanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-acceptance-race"]')
  const raceComposer = racePanel.getByLabel('Chat message')
  await raceComposer.fill('Acceptance event racing recovery state')
  await raceComposer.press('Enter')
  await racePanel.getByText('Acceptance event racing recovery state').waitFor({ timeout: 2_000 })
  await racePanel.locator('[data-composer-send-error]').waitFor({ state: 'detached', timeout: 2_000 })
  assert(
    !(await raceComposer.textContent())?.includes('Acceptance event racing recovery state'),
    'canonical acceptance clears recovery even when it races the ambiguous response',
  )

  await selectSidebarSession(win, 'Idle Resolution Failure', 'idle-resolution-failure')
  const resolutionFailurePanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-resolution-failure"]')
  const resolutionFailureComposer = resolutionFailurePanel.getByLabel('Chat message')
  await resolutionFailureComposer.fill('Original ambiguous payload')
  await resolutionFailureComposer.press('Enter')
  await resolutionFailurePanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  await resolutionFailureComposer.fill('Edited payload blocked by recovery')
  const acceptResolutionWarning = async (dialog) => dialog.accept()
  win.on('dialog', acceptResolutionWarning)
  await resolutionFailureComposer.press('Enter')
  await resolutionFailureComposer.fill('Newest draft typed while resolving')
  await resolutionFailurePanel.getByText('Fixture could not resolve the earlier delivery').waitFor({ timeout: 2_000 })
  win.off('dialog', acceptResolutionWarning)
  assert(
    (await resolutionFailureComposer.textContent())?.includes('Newest draft typed while resolving'),
    'failed ambiguity resolution preserves text typed during the round trip',
  )
  const restoreBlockedPayload = async (dialog) => dialog.accept()
  win.on('dialog', restoreBlockedPayload)
  await resolutionFailurePanel.locator('[data-composer-recovery] button', { hasText: 'Restore' }).click()
  win.off('dialog', restoreBlockedPayload)
  assert(
    (await resolutionFailureComposer.textContent())?.includes('Edited payload blocked by recovery'),
    'failed ambiguity resolution keeps the detached submitted payload recoverable',
  )

  await selectSidebarSession(win, 'Idle Resolution Not Found', 'idle-resolution-not-found')
  const notFoundPanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-resolution-not-found"]')
  const notFoundComposer = notFoundPanel.getByLabel('Chat message')
  await notFoundComposer.fill('Ambiguous request with no durable row')
  await notFoundComposer.press('Enter')
  await notFoundPanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  await notFoundComposer.fill('Edited request after missing row')
  const acceptNotFoundWarning = async (dialog) => dialog.accept()
  win.on('dialog', acceptNotFoundWarning)
  await notFoundComposer.press('Enter')
  await notFoundPanel.getByText('Edited request after missing row').waitFor({ timeout: 2_000 })
  win.off('dialog', acceptNotFoundWarning)
  await notFoundPanel.locator('[data-composer-send-error]').waitFor({ state: 'detached', timeout: 2_000 })
  assert(
    (await app.evaluate(() => globalThis.__sbIdleResolutionNotFoundOrigins)).length === 2,
    'missing durable recovery row allows the edited turn to proceed once',
  )

  await selectSidebarSession(win, 'Idle Ambiguous', 'idle-ambiguous')
  const ambiguousPanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-ambiguous"]')
  const ambiguousComposer = ambiguousPanel.getByLabel('Chat message')
  await ambiguousComposer.fill('Ambiguous message awaiting confirmation')
  await ambiguousComposer.press('Enter')
  await ambiguousPanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  assert(
    await ambiguousPanel.locator('.chat-composer button', { hasText: 'Retry safely' }).count() === 1,
    'ambiguous rollback exposes a safe idempotent retry',
  )
  const [ambiguousOrigin] = await app.evaluate(() => globalThis.__sbIdleAmbiguousOrigins)
  await selectSidebarSession(win, 'Idle Feedback', 'idle-feedback')
  await emitProviderEvents([{
    type: 'user.message',
    threadId: 'idle-ambiguous',
    origin: ambiguousOrigin,
    text: 'Ambiguous message awaiting confirmation',
    at: Date.now(),
  }])
  await selectSidebarSession(win, 'Idle Ambiguous', 'idle-ambiguous')
  await ambiguousPanel.locator('[data-composer-send-error]').waitFor({ state: 'detached', timeout: 2_000 })
  assert(
    !(await ambiguousComposer.textContent())?.includes('Ambiguous message awaiting confirmation'),
    'late canonical acceptance clears an unchanged restored draft while hidden',
  )
  let unexpectedRecoveryDialog = false
  const dismissUnexpectedRecoveryDialog = async (dialog) => {
    unexpectedRecoveryDialog = true
    await dialog.dismiss()
  }
  win.on('dialog', dismissUnexpectedRecoveryDialog)
  await ambiguousComposer.fill('Message after late acceptance')
  await ambiguousComposer.press('Enter')
  await win.waitForTimeout(250)
  win.off('dialog', dismissUnexpectedRecoveryDialog)
  assert(!unexpectedRecoveryDialog, 'late acceptance clears stale recovery state before the next send')

  await selectSidebarSession(win, 'Idle Edited Ambiguous', 'idle-edited-ambiguous')
  const editedPanel = win.locator('[data-chat-slot="primary"][data-session-id="idle-edited-ambiguous"]')
  const editedComposer = editedPanel.getByLabel('Chat message')
  await editedComposer.fill('Ambiguous message before edit')
  await editedComposer.press('Enter')
  await editedPanel.locator('[data-composer-send-error]').waitFor({ timeout: 2_000 })
  await editedComposer.fill('Edited message after ambiguity')
  let editedWarningCount = 0
  const acceptEditedWarning = async (dialog) => {
    editedWarningCount += 1
    await dialog.accept()
  }
  win.on('dialog', acceptEditedWarning)
  await editedComposer.press('Enter')
  await editedPanel.locator('[data-message-list-scroll]').getByText('Edited message after ambiguity').waitFor({ timeout: 3_000 })
  win.off('dialog', acceptEditedWarning)
  assert(editedWarningCount === 1, 'edited ambiguous delivery requires exactly one warning')
  const editedOrigins = await app.evaluate(() => globalThis.__sbIdleEditedAmbiguousOrigins)
  assert(
    editedOrigins.length === 3
      && editedOrigins[0] === editedOrigins[1]
      && editedOrigins[1] !== editedOrigins[2],
    'edited ambiguous delivery creates exactly one new delivery id',
  )
  const editedRecoveryOrder = await app.evaluate(() => globalThis.__sbIdleEditedRecoveryOrder)
  assert(
    editedRecoveryOrder.length === 4
      && editedRecoveryOrder[0].startsWith('submit:')
      && editedRecoveryOrder[1] === `resolve:${editedOrigins[0]}`
      && editedRecoveryOrder[2] === `submit:${editedOrigins[0]}`
      && editedRecoveryOrder[3] === `submit:${editedOrigins[2]}`,
    'edited ambiguity resolves the prior delivery before submitting the new id',
  )
  const editedTranscript = await editedPanel.locator('[data-message-id]').evaluateAll((rows) =>
    rows.map((row) => row.textContent ?? ''),
  )
  const recoveredIndex = editedTranscript.findIndex((text) => text.includes('Ambiguous message before edit'))
  const editedIndex = editedTranscript.findIndex((text) => text.includes('Edited message after ambiguity'))
  assert(
    recoveredIndex >= 0 && editedIndex > recoveredIndex,
    'completed recovery renders before the newly submitted edited turn',
  )

  // A large remote history arrives in one load. Dynamic row measurement must
  // finish without leaving tall turns at the 120 px estimate, which paints
  // later absolutely positioned turns over their content.
  await selectSidebarSession(win, 'Tall History', 'tall-history')
  await win.locator('[data-chat-slot="primary"]').getByText('Tall turn 30').waitFor()
  await win.waitForTimeout(1_000)
  const transcriptGeometry = await win.locator('[data-chat-slot="primary"] [data-index]').evaluateAll((rows) =>
    rows
      .map((row) => {
        const rect = row.getBoundingClientRect()
        return { index: Number(row.getAttribute('data-index')), top: rect.top, bottom: rect.bottom }
      })
      .sort((a, b) => a.index - b.index),
  )
  const overlappingTurns = transcriptGeometry.filter((row, index) => {
    const next = transcriptGeometry[index + 1]
    return next && next.top < row.bottom - 0.5
  })
  assert(transcriptGeometry.length > 1, 'tall history mounts multiple virtual rows')
  assert(overlappingTurns.length === 0, 'dynamically measured history rows never overlap')

  const liveParagraph = Array.from({ length: 12 }, (_, index) => `live wrapped line ${index + 1}`).join('\n')
  for (let index = 0; index < 18; index++) {
    await emitProviderEvents([
      {
        type: 'user.message',
        threadId: 'tall-history',
        at: Date.now() + index * 2,
        origin: `live-origin-${index}`,
        text: `Live user turn ${index + 1}\n${liveParagraph}`,
      },
      {
        type: 'question.asked',
        threadId: 'tall-history',
        requestId: `live-question-${index}`,
        questions: [{
          id: `live-question-${index}.0`,
          header: 'Rendering check',
          question: `Live question ${index + 1}: choose a layout option`,
          multiSelect: false,
          options: Array.from({ length: 4 }, (_, option) => ({
            label: `Option ${option + 1}`,
            description: 'This description makes the dynamically measured card taller.',
          })),
        }],
      },
      {
        type: 'question.answered',
        threadId: 'tall-history',
        requestId: `live-question-${index}`,
        answers: [['Option 1']],
      },
    ])
    await win.waitForTimeout(30)
  }
  await win.locator('[data-chat-slot="primary"]').getByText('Live question 18: choose a layout option').waitFor()
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const liveGeometry = await win.locator('[data-chat-slot="primary"] [data-index]').evaluateAll((rows) =>
    rows
      .map((row) => {
        const rect = row.getBoundingClientRect()
        return { index: Number(row.getAttribute('data-index')), top: rect.top, bottom: rect.bottom }
      })
      .sort((a, b) => a.index - b.index),
  )
  const overlappingLiveTurns = liveGeometry.filter((row, index) => {
    const next = liveGeometry[index + 1]
    return next && next.top < row.bottom - 0.5
  })
  assert(liveGeometry.length > 1, 'live tall history mounts multiple virtual rows')
  if (overlappingLiveTurns.length > 0) {
    console.error('overlapping live turn geometry', JSON.stringify({ liveGeometry, overlappingLiveTurns }))
  }
  assert(overlappingLiveTurns.length === 0, 'live dynamically measured rows never overlap while following')

  // Grow one already-mounted assistant message in place. This preserves both
  // its message id and its virtual turn key, matching streaming/card updates
  // that change height without appending another transcript row.
  await emitProviderEvents([{
    type: 'content',
    threadId: 'tall-history',
    messageId: 'same-key-growth',
    text: 'same-key start',
    streamKind: 'assistant',
  }])
  await win.locator('[data-chat-slot="primary"]').getByText('same-key start').waitFor()
  const grownText = Array.from({ length: 90 }, (_, index) => `same-key grown line ${index + 1}`).join('\n')
  await emitProviderEvents([{
    type: 'content',
    threadId: 'tall-history',
    messageId: 'same-key-growth',
    text: grownText,
    streamKind: 'assistant',
  }])
  await win.locator('[data-chat-slot="primary"]').getByText('same-key grown line 90').waitFor()
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const sameKeyOverlaps = await win.locator('[data-chat-slot="primary"] [data-index]').evaluateAll((rows) =>
    rows
      .map((row) => row.getBoundingClientRect())
      .some((row, index, rects) => rects[index + 1] && rects[index + 1].top < row.bottom - 0.5),
  )
  assert(!sameKeyOverlaps, 'an existing virtual turn can grow in place without overlapping its successor')

  // Load both histories once, then restore A as the primary chat.
  await selectSidebarSession(win, 'Dual A', 'dual-a')
  await win.locator('[data-chat-slot="primary"]').getByText('Seed response from A').waitFor()
  await selectSidebarSession(win, 'Dual B', 'dual-b')
  await win.locator('[data-chat-slot="primary"]').getByText('Seed response from B').waitFor()
  await selectSidebarSession(win, 'Dual A', 'dual-a')
  await win.locator('[data-chat-slot="primary"]').getByText('Seed response from A').waitFor()

  const primary = win.locator('[data-chat-slot="primary"]')
  await primary.getByRole('button', { name: 'Open beside' }).click()
  await win.locator('.sb-floating-surface').getByRole('button', { name: /Dual B/ }).click()

  const secondary = win.locator('[data-chat-slot="secondary"]')
  await secondary.waitFor()
  assert(await primary.getAttribute('data-session-id') === 'dual-a', 'session A remains primary')
  assert(await secondary.getAttribute('data-session-id') === 'dual-b', 'session B opens in the secondary slot')
  await secondary.getByText('Seed response from B').waitFor()
  console.log('✓ session B loads its historical messages')

  const primaryComposer = primary.getByLabel('Chat message')
  const secondaryComposer = secondary.getByLabel('Chat message')
  await primaryComposer.fill('Independent draft A')
  await secondaryComposer.fill('Independent draft B')
  assert((await primaryComposer.textContent())?.includes('Independent draft A'), 'primary draft is independent')
  assert((await secondaryComposer.textContent())?.includes('Independent draft B'), 'secondary draft is independent')

  await secondaryComposer.click()
  await win.locator('[data-status-bar][data-session-id="dual-b"]').waitFor()
  assert(await secondary.getAttribute('data-focused') === 'true', 'composer focus establishes the secondary slot')
  assert(await primary.getAttribute('data-focused') === 'false', 'primary focus treatment clears when secondary is focused')
  console.log('✓ status and companion surfaces bind to the focused secondary session')

  await emitProviderEvents([
    { type: 'content', threadId: 'dual-a', messageId: 'stream-a', text: 'STREAM-A-ONLY', streamKind: 'assistant' },
    { type: 'content', threadId: 'dual-b', messageId: 'stream-b', text: 'STREAM-B-', streamKind: 'assistant' },
    { type: 'content', threadId: 'dual-b', messageId: 'stream-b', text: 'ONLY', append: true, streamKind: 'assistant' },
    { type: 'turn.completed', threadId: 'dual-b', durationMs: 25 },
    { type: 'tool.started', threadId: 'dual-a', toolId: 'after-b', toolName: 'Read', input: {} },
    { type: 'turn.completed', threadId: 'dual-a', durationMs: 30 },
  ])
  await primary.getByText('STREAM-A-ONLY').waitFor()
  await secondary.getByText('STREAM-B-ONLY').waitFor()
  assert(await primary.getByText('STREAM-B-ONLY').count() === 0, 'B stream never renders in A')
  assert(await secondary.getByText('STREAM-A-ONLY').count() === 0, 'A stream never renders in B')

  await primary.locator('button[title="Forward to another agent"]').first().click()
  await win.getByRole('button', { name: /Send to other panel · Dual B/ }).click()
  await win.waitForFunction(() => {
    const composer = document.querySelector('[data-chat-slot="secondary"] [aria-label="Chat message"]')
    return composer?.textContent?.includes('Forwarded from Claude')
  })
  const forwardedDraft = await secondaryComposer.textContent()
  assert(forwardedDraft?.includes('Independent draft B'), 'forwarding preserves the receiving draft')
  assert(forwardedDraft?.includes('Seed response from A'), 'forwarding uses the message owning session')
  assert(await secondary.getAttribute('data-focused') === 'true', 'forwarding focuses the receiving panel')

  await secondary.locator('button[title^="Close this panel"]').evaluate((button) => button.click())
  await win.locator('[data-chat-slot="primary"][data-session-id="dual-a"]').waitFor()
  await win.waitForFunction(() => !document.querySelector('[data-chat-slot="secondary"][data-session-id]'))
  assert(await win.locator('[data-chat-slot="secondary"][data-session-id]').count() === 0, 'closing secondary leaves A intact')

  await primary.getByRole('button', { name: 'Open beside' }).click()
  await win.locator('.sb-floating-surface').getByRole('button', { name: /Dual B/ }).click()
  await win.locator('[data-chat-slot="secondary"][data-session-id="dual-b"]').waitFor()
  assert((await secondaryComposer.textContent())?.includes('Independent draft B'), 'reopening B preserves its independent draft')
  assert(await secondary.getByText('STREAM-B-ONLY').count() === 1, 'reopening B preserves streamed messages without duplication')

  // Narrow workspaces present dual chats as tabs and retain both panels with
  // display:none. Messages arriving in the hidden tab must be measured and
  // bottom-anchored when focus reveals it without changing its session id.
  await win.setViewportSize({ width: 640, height: 900 })
  await win.locator('[data-chat-workspace][data-chat-presentation="tabs"]').waitFor()
  await win.getByRole('tab', { name: 'Dual A' }).click()
  await win.locator('[data-chat-slot-wrapper="secondary"]').waitFor({ state: 'hidden' })
  const hiddenEvents = Array.from({ length: 36 }, (_, index) => ({
    type: index % 2 === 0 ? 'user.message' : 'content',
    threadId: 'dual-b',
    ...(index % 2 === 0
      ? { at: Date.now() + index, origin: `hidden-origin-${index}`, text: `Hidden tab turn ${index + 1}` }
      : { messageId: `hidden-answer-${index}`, text: `Hidden tab answer ${index + 1}\n${liveParagraph}`, streamKind: 'assistant' }),
  }))
  await emitProviderEvents(hiddenEvents)
  await win.getByRole('tab', { name: 'Dual B' }).click()
  await win.locator('[data-chat-slot-wrapper="secondary"]').waitFor({ state: 'visible' })
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const revealedScroll = await secondary.locator('[data-message-list-scroll]').evaluate((scroller) => {
    return {
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    }
  })
  if (revealedScroll.scrollTop + revealedScroll.clientHeight < revealedScroll.scrollHeight - 2) {
    console.error('revealed hidden chat scroll geometry', JSON.stringify(revealedScroll))
  }
  assert(
    revealedScroll.scrollTop + revealedScroll.clientHeight >= revealedScroll.scrollHeight - 2,
    'revealing a populated hidden chat restores its bottom anchor',
  )

  console.log('\nall dual-chat workspace checks passed')
} finally {
  if (app) await app.close().catch(() => {})
  cleanup()
}

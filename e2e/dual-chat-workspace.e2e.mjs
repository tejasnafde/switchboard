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
  await win.locator('.sidebar-thread-main', { hasText: title }).click()
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
    await window.api.app.saveMessage({ id: 'seed-a', conversationId: 'dual-a', role: 'assistant', content: 'Seed response from A' })
    await window.api.app.saveMessage({ id: 'seed-b', conversationId: 'dual-b', role: 'assistant', content: 'Seed response from B' })
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
  await win.locator('.sidebar-thread-title', { hasText: 'Dual A' }).waitFor({ timeout: 20_000 })

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

  console.log('\nall dual-chat workspace checks passed')
} finally {
  if (app) await app.close().catch(() => {})
  cleanup()
}

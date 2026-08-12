#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build:fast first')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-visual-e2e-'))
const screenshotPath = join(tmpdir(), 'switchboard-visual-translucent.png')
const snapshotPath = join(repoRoot, 'e2e', 'snapshots', `visual-regressions-translucent-${process.platform}.png`)
let app

const cleanup = () => {
  rmSync(userDataDir, { recursive: true, force: true })
}
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function compareScreenshot(actual) {
  if (process.env.SB_UPDATE_VISUAL_SNAPSHOTS === '1') {
    mkdirSync(join(repoRoot, 'e2e', 'snapshots'), { recursive: true })
    writeFileSync(snapshotPath, actual)
    return
  }
  if (!existsSync(snapshotPath)) throw new Error(`missing visual baseline: ${snapshotPath}`)
  const expectedPng = PNG.sync.read(readFileSync(snapshotPath))
  const actualPng = PNG.sync.read(actual)
  if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) {
    throw new Error(`visual size changed: ${actualPng.width}x${actualPng.height}`)
  }
  let changed = 0
  for (let i = 0; i < actualPng.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(actualPng.data[i] - expectedPng.data[i]),
      Math.abs(actualPng.data[i + 1] - expectedPng.data[i + 1]),
      Math.abs(actualPng.data[i + 2] - expectedPng.data[i + 2]),
      Math.abs(actualPng.data[i + 3] - expectedPng.data[i + 3]),
    )
    if (delta > 12) changed++
  }
  const ratio = changed / (actualPng.width * actualPng.height)
  if (ratio > 0.005) throw new Error(`visual mismatch: ${(ratio * 100).toFixed(2)}% of pixels changed`)
}

async function closeApp() {
  if (!app) return
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!closed) app.process().kill('SIGKILL')
}

try {
  app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      SB_USER_DATA: userDataDir,
    },
  })
  const win = await app.firstWindow({ timeout: 20_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })

  await win.waitForTimeout(600)
  await win.keyboard.press('Escape')
  await win.getByTitle('Settings').click()
  const translucent = win.getByRole('button', { name: /Translucent/ })
  await translucent.waitFor({ state: 'visible' })
  await translucent.click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  const runtimeMode = win.locator('.runtime-mode-select')
  await runtimeMode.evaluate((element) => { element.dataset.runtimeMode = 'full-access' })

  const theme = await win.evaluate(() => {
    const root = document.querySelector('#root')
    const sidebar = document.querySelector('.sidebar-root')
    const rootStyle = root ? getComputedStyle(root) : null
    return {
      className: document.documentElement.className,
      primary: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
      rootBackground: rootStyle?.backgroundColor ?? null,
      sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
      composerShadow: getComputedStyle(document.querySelector('.chat-composer')).boxShadow,
      modeBorder: getComputedStyle(document.querySelector('.runtime-mode-select')).borderTopColor,
    }
  })

  const toolLayout = await win.evaluate(() => {
    const fixture = document.createElement('details')
    fixture.className = 'turn-activity'
    fixture.open = true
    fixture.dataset.visualFixture = 'tool-summary'
    fixture.style.cssText = 'position:fixed;left:20px;top:20px;width:440px;height:104px;margin:0;padding:12px;background:rgb(8,10,14);z-index:99999'
    fixture.innerHTML = `
      <summary><span data-summary-label>Used 3 tools</span></summary>
      <div class="turn-activity-body">
        <div class="message-bubble-row"><div class="message-bubble">
          <div class="tool-call-row"><button class="tool-call-trigger" type="button">
            <span data-tool-icon style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg></span>
            <span>Edit</span>
          </button></div>
        </div></div>
      </div>`
    document.body.append(fixture)
    const summary = fixture.querySelector('summary')
    const summaryLabel = fixture.querySelector('[data-summary-label]')
    const icon = fixture.querySelector('[data-tool-icon]')
    const row = fixture.querySelector('.message-bubble-row')
    const result = {
      summaryDisplay: getComputedStyle(summary).display,
      summaryAlign: getComputedStyle(summary).alignItems,
      rowPaddingLeft: getComputedStyle(row).paddingLeft,
      alignmentDelta: Math.abs(summaryLabel.getBoundingClientRect().left - icon.getBoundingClientRect().left),
    }
    return result
  })

  const screenshot = await win.locator('[data-visual-fixture="tool-summary"]').screenshot({ path: screenshotPath })
  compareScreenshot(screenshot)

  if (theme.className !== 'theme-translucent') throw new Error(`theme class: ${theme.className}`)
  if (theme.primary !== 'rgba(8, 10, 14, 0.7)') throw new Error(`primary tint: ${theme.primary}`)
  if (theme.rootBackground !== 'rgba(8, 10, 14, 0.7)') {
    throw new Error(`root background: ${theme.rootBackground}`)
  }
  if (theme.sidebarBackground !== 'rgba(8, 10, 14, 0.36)') {
    throw new Error(`sidebar background: ${theme.sidebarBackground}`)
  }
  if (theme.composerShadow !== 'none') throw new Error(`composer shadow: ${theme.composerShadow}`)
  if (theme.modeBorder !== 'rgb(210, 153, 34)') throw new Error(`mode border: ${theme.modeBorder}`)
  if (toolLayout.summaryDisplay !== 'flex' || toolLayout.summaryAlign !== 'center') {
    throw new Error(`tool summary alignment: ${JSON.stringify(toolLayout)}`)
  }
  if (toolLayout.rowPaddingLeft !== '0px' || toolLayout.alignmentDelta > 2) {
    throw new Error(`tool tree padding: ${JSON.stringify(toolLayout)}`)
  }

  console.log(`E2E PASSED - translucent theme screenshot: ${screenshotPath}`)
} catch (error) {
  console.error(`E2E FAILED - ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await closeApp()
  cleanup()
}

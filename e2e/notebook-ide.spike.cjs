/*
 * Phase 0 spike harness for data scientist mode (docs/plans/2026-07-18-data-scientist-mode-design.md).
 * Drives an embedded code-server workbench with Playwright and asserts the Jupyter
 * extension stack works end to end: notebook renders as cells, a project .venv kernel
 * is selectable, Run All produces rich outputs (pandas HTML table, matplotlib <img>,
 * shared-state text output).
 *
 * Passed 2026-07-18 against code-server 4.127.0 + ms-toolsai.jupyter 2025.9.1 (Open VSX).
 *
 * Setup (manual, one-time):
 *   SPIKE=/tmp/sb-dsmode-spike
 *   BIN="$HOME/Library/Application Support/switchboard/code-server/4.127.0/code-server-4.127.0-macos-arm64/bin/code-server"
 *   mkdir -p "$SPIKE/ext" "$SPIKE/data/User" "$SPIKE/project"
 *   "$BIN" --extensions-dir "$SPIKE/ext" --user-data-dir "$SPIKE/data" \
 *     --install-extension ms-toolsai.jupyter --install-extension ms-python.python
 *   echo '{"security.workspace.trust.enabled": false}' > "$SPIKE/data/User/settings.json"
 *   python3 -m venv "$SPIKE/project/.venv" && "$SPIKE/project/.venv/bin/pip" install ipykernel matplotlib pandas
 *   # write a test notebook (markdown + pandas df + matplotlib plot + print of df sum == 555)
 *   "$BIN" --auth none --bind-addr 127.0.0.1:8377 --extensions-dir "$SPIKE/ext" --user-data-dir "$SPIKE/data" &
 *   node e2e/notebook-ide.spike.cjs
 *
 * MANDATORY cleanup after any run (see CLAUDE.md e2e temp-dir rule):
 *   rm -rf /tmp/sb-dsmode-spike
 */
const { chromium } = require('playwright')

const URL = process.env.SPIKE_URL ?? 'http://127.0.0.1:8377/?folder=/tmp/sb-dsmode-spike/project'
const SHOT = process.env.SPIKE_SHOT ?? '/tmp/sb-dsmode-spike/verify.png'

function ok(label) {
  console.log(`PASS  ${label}`)
}

/** Poll all frames (webview outputs render in nested iframes) until predicate hits. */
async function findFrame(page, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if (await predicate(frame)) return frame
      } catch {
        /* frame detached mid-poll; keep going */
      }
    }
    await page.waitForTimeout(2000)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.setDefaultTimeout(60_000)

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.locator('.monaco-workbench').waitFor()
    ok('workbench loaded')

    // Let the extension host finish registering editor providers before opening,
    // otherwise the .ipynb falls back to the plain JSON text editor.
    await page.waitForTimeout(8000)

    // Open the notebook from the explorer; "Select Kernel" appearing = notebook editor active
    await page.getByRole('treeitem', { name: /client_analysis_final_v2\.ipynb/ }).click()
    const selectKernel = page.getByRole('button', { name: /Select Kernel/i })
    try {
      await selectKernel.waitFor({ timeout: 20_000 })
    } catch {
      console.log('INFO  notebook editor not detected, forcing Reopen With > Jupyter')
      await page.keyboard.press('F1')
      const palette = page.locator('.quick-input-widget')
      await palette.waitFor()
      await page.keyboard.type('reopen with')
      await page.waitForTimeout(1000)
      await page.keyboard.press('Enter') // View: Reopen Editor With...
      await palette.locator('.monaco-list-row', { hasText: /Jupyter Notebook/i }).first().click()
      await selectKernel.waitFor({ timeout: 30_000 })
    }
    // Prove it's cells, not the raw JSON text editor
    const rawJson = await page.getByText('"cell_type"').count()
    if (rawJson > 0) throw new Error('raw notebook JSON is visible - not the notebook editor')
    ok('notebook renders as cells (notebook editor active, no raw JSON)')

    // Select the .venv kernel explicitly
    await selectKernel.click()
    const quickInput = page.locator('.quick-input-widget')
    await quickInput.waitFor()
    await quickInput.locator('.monaco-list-row', { hasText: /Python Environments/i }).first().click()
    await quickInput.locator('.monaco-list-row', { hasText: /\.venv/ }).first().click()
    ok('.venv kernel selected via Python Environments picker')

    // Run all cells; first run pays kernel startup + matplotlib import
    await page.getByRole('button', { name: /Run All/i }).first().click()

    const outFrame = await findFrame(
      page,
      async (f) => (await f.getByText('kernel state check: 555').count()) > 0,
      240_000,
      'shared-state text output (kernel state check: 555)'
    )
    ok('cells executed with shared kernel state (sum = 555)')

    const imgs = await outFrame.locator('img').count()
    if (imgs < 1) throw new Error('no <img> output found (matplotlib plot missing)')
    ok(`matplotlib plot rendered as image (${imgs} img element[s])`)

    const tables = await outFrame.locator('table').count()
    if (tables < 1) throw new Error('no <table> output found (pandas HTML repr missing)')
    ok(`pandas dataframe rendered as HTML table (${tables} table[s])`)

    await page.screenshot({ path: SHOT, fullPage: false })
    console.log(`\nALL CHECKS PASSED - evidence: ${SHOT}`)
  } catch (err) {
    await page.screenshot({ path: SHOT, fullPage: false }).catch(() => {})
    console.error(`\nFAILED: ${err.message}\nscreenshot: ${SHOT}`)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main()

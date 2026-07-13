#!/usr/bin/env node
/**
 * Syntax-highlighting probe: opens a real TS file in the embedded workbench
 * under Switchboard Charcoal and asserts the rendered tokens use MULTIPLE
 * distinct colors. This is the check the earlier "content is visible" e2e
 * could not make - an empty tokenColors theme (the 0.7.5-0.7.7 bug) renders
 * every token in one foreground color, which this catches.
 *
 * Opt-in (downloads the code-server binary on a cold run):
 *   SB_IDE_PROBE=1 node e2e/ide-syntax.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SB_IDE_PROBE !== '1') {
  console.log('skipped - set SB_IDE_PROBE=1 to run (downloads the code-server binary)')
  process.exit(0)
}

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const project = mkdtempSync(join(tmpdir(), 'sb-syntax-proj-'))
writeFileSync(
  join(project, 'sample.ts'),
  [
    '// a comment line',
    'import { readFile } from "node:fs"',
    'const answer: number = 42',
    'function greet(name: string): string {',
    '  return `hello ${name}`',
    '}',
  ].join('\n'),
)
execFileSync('git', ['init', '-q'], { cwd: project })

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-syntax-ud-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.evaluate((dir) => window.api.routing.invokeOn('local', 'app:add-project-path', dir), project)
  await win.evaluate(() => window.api.settings.set('tour.autoplay', 'false'))
  await win.reload()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.keyboard.press('Escape')

  const row = win.locator('.sidebar-project-header', { hasText: project.split('/').pop() }).first()
  await row.hover()
  await row.locator('.sidebar-project-compose').click({ force: true })
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+Shift+E')

  console.log('  (cold boot may download the code-server tarball - allow a few minutes)')
  let workbench = null
  for (let i = 0; i < 240 && !workbench; i++) {
    await win.waitForTimeout(1000)
    workbench = app.windows().find((p) => p.url().includes('127.0.0.1')) ?? null
  }
  if (!workbench) throw new Error('webview never navigated to the workbench URL')
  await workbench.waitForSelector('.monaco-workbench', { timeout: 120_000 })

  // Open sample.ts and wait for it to render.
  let routed = false
  for (let i = 0; i < 60 && !routed; i++) {
    await win.waitForTimeout(1000)
    const res = await win.evaluate((dir) => window.api.ide.open({ folder: dir, path: 'sample.ts', line: 1 }), project)
    routed = res?.ok === true
  }
  check(routed, 'sample.ts routed to the workbench')
  await workbench.waitForSelector('.monaco-editor .view-lines .mtk1, .monaco-editor .view-lines span', { timeout: 30_000 })

  // TextMate colors render as inline `color:` on token spans (Monaco emits
  // per-token <span class="mtkN"> with colors from a generated stylesheet).
  // Read the computed color of every token span; a working theme yields many
  // distinct colors, the empty-tokenColors bug yields one.
  const distinctColors = await workbench.evaluate(() => {
    const spans = document.querySelectorAll('.monaco-editor .view-lines span[class*="mtk"]')
    const colors = new Set()
    for (const s of spans) colors.add(getComputedStyle(s).color)
    return [...colors]
  })
  console.log(`  (distinct token colors: ${distinctColors.length})`)
  check(distinctColors.length >= 4, `syntax highlighting active: ${distinctColors.length} distinct token colors (bug = 1)`)

  // The comment should be the muted grey we set, distinct from code.
  const commentColored = await workbench.evaluate(() => {
    const line = document.querySelector('.monaco-editor .view-lines .view-line')
    if (!line) return false
    const span = line.querySelector('span[class*="mtk"]')
    return span ? getComputedStyle(span).color !== getComputedStyle(document.body).color : false
  })
  check(commentColored, 'first-line comment is themed (not default foreground)')
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)

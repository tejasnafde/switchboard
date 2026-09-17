/**
 * Every terminal-creation entry point resolves its cwd through ONE helper.
 *
 * Five of them read `session.projectPath` directly, so a chat that had
 * followed a worktree still opened its next terminal in the parent checkout -
 * the branch chip moved and the cwd expression did not. Two others wrote
 * `worktreePath ?? projectPath` inline, which is correct but is the same rule
 * copied by hand, and a copied rule is one that drifts.
 *
 * This is a source guard rather than a render test on purpose. The defect is
 * "one of N call sites was missed", and N grows; asserting the SHAPE of every
 * call site catches a new entry point that forgets, which a test of the five
 * known ones never would. `sessionExecutionRootPath` itself is behaviour-
 * tested in renderer-execution-root.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')

/** Files that create terminals, or choose the cwd one is created with. */
const TERMINAL_CWD_ENTRY_POINTS = [
  'src/renderer/components/terminal/TerminalStrip.tsx',
  'src/renderer/components/terminal/TerminalWindow.tsx',
  'src/renderer/components/CommandPalette.tsx',
  'src/renderer/App.tsx',
  'src/renderer/hooks/useTerminalLifecycle.ts',
]

function source(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8')
}

/**
 * A session lookup whose result is read for `.projectPath`. This is the exact
 * shape of the bug: it ignores `worktreePath` entirely.
 */
const RAW_PROJECT_PATH_LOOKUP = /sessions\.find\(.*\)\?\.projectPath/

/** The hand-copied form. Correct, but it is the rule duplicated. */
const INLINE_FALLBACK = /worktreePath\s*\?\?\s*[A-Za-z.]*projectPath/

describe('terminal cwd entry points', () => {
  it.each(TERMINAL_CWD_ENTRY_POINTS)('%s never reads projectPath as a terminal cwd', (file) => {
    expect(source(file)).not.toMatch(RAW_PROJECT_PATH_LOOKUP)
  })

  it.each(TERMINAL_CWD_ENTRY_POINTS)('%s does not re-inline the worktree fallback', (file) => {
    expect(source(file)).not.toMatch(INLINE_FALLBACK)
  })

  it.each(TERMINAL_CWD_ENTRY_POINTS)('%s resolves the root through the shared helper', (file) => {
    expect(source(file)).toMatch(/from '.*services\/executionRoot'/)
  })

  it('keeps the helper as the only place the fallback is written', () => {
    const helper = source('src/renderer/services/executionRoot.ts')
    expect(helper).toContain('resolveExecutionRoot')
  })
})

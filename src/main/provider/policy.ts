/**
 * Shared permission policy for provider adapters.
 *
 * Both Claude and Codex enforce the same user-facing policy (Plan mode
 * denies mutations, Sandbox prompts, Accept-Edits auto-allows file tools,
 * Full-Access allows everything). Keeping the logic in one pure function
 * means any adapter can reuse it and there's a single place to update
 * policy rules.
 *
 * Not all tool names are identical across providers - Codex uses tool
 * names like `shell`, `edit`, etc. The policy normalizes via tool-name
 * equivalence sets (`EQUIV_EDIT_TOOLS`) so the same mode produces the same
 * behavior regardless of provider.
 */

import type { RuntimeMode } from '@shared/provider-events'
import { mirrorRelPathFor } from '../notebooks/mirror-format'
import { extractWritePaths, toPosix } from './worktree-drift'

/**
 * Read-only tools allowed in Plan mode. Mutations (Edit/Write/MultiEdit/
 * NotebookEdit/Bash/MCP) are denied. ExitPlanMode and AskUserQuestion are
 * handled earlier in canUseTool and never reach the mode check.
 */
export const PLAN_READ_ONLY_TOOLS = new Set([
  // Claude Code
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  // Codex equivalents - names the app-server uses
  'read_file',
  'list_files',
  'search_files',
  'fetch',
])

/**
 * Tools rendered via custom UI (QuestionCard / PlanCard). Their raw
 * `tool_use` block is suppressed from the chat so only the card shows.
 */
export const CUSTOM_UI_TOOLS = new Set([
  // Claude SDK
  'AskUserQuestion',
  'ExitPlanMode',
  // Codex equivalents (names used in app-server notifications)
  'ask_user_question',
  'exit_plan_mode',
])

/**
 * Tools that should be auto-allowed in Accept-Edits mode (the "just edit
 * files without asking" shortcut). All other tools fall through to prompt.
 */
const EDIT_TOOLS = new Set([
  // Claude
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  // Codex
  'write_file',
  'patch',
  'apply_patch',
])

export type PermissionDecision = 'allow' | 'deny' | 'prompt'

/**
 * Decide what to do with a tool call given the session's runtime mode.
 *
 * - `allow`  → adapter returns `{ behavior: 'allow' }` immediately
 * - `deny`   → adapter returns `{ behavior: 'deny' }` + emits `tool.denied`
 * - `prompt` → adapter emits `request.opened` and blocks until the user decides
 *
 * Kept stateless + exported so policy changes have direct unit tests.
 */
export function decidePermission(mode: RuntimeMode, toolName: string): PermissionDecision {
  if (mode === 'full-access') return 'allow'

  if (mode === 'accept-edits') {
    if (EDIT_TOOLS.has(toolName)) return 'allow'
    return 'prompt'
  }

  if (mode === 'plan') {
    if (PLAN_READ_ONLY_TOOLS.has(toolName)) return 'allow'
    return 'deny'
  }

  // sandbox (default) - always prompt
  return 'prompt'
}

/**
 * Human-readable denial reason. Used by both adapters when they emit
 * `tool.denied` so the UI pill shows the same copy regardless of provider.
 */
export function denialMessage(mode: RuntimeMode, _toolName: string): string {
  if (mode === 'plan') {
    return 'Plan mode - tool execution is blocked. Use ExitPlanMode to propose your plan, or switch to Sandbox/Accept-Edits to execute.'
  }
  return 'Denied by permission policy'
}

export interface NotebookRedirect {
  /** Repo-relative notebook path, or null when the write is outside the repo. */
  notebookRelPath: string | null
  /** Repo-relative mirror path, or null when the write is outside the repo. */
  mirrorRelPath: string | null
  /** Denial copy that teaches the agent the mirror path - self-healing. */
  message: string
}

/**
 * Collapse '.' and '..' segments without touching the filesystem. Returns
 * null when '..' underflows past the root - callers treat that as outside
 * the repo. Preserves a leading '/' or drive-letter prefix.
 */
function normalizePosix(p: string): string | null {
  const lead = p.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // A drive-letter prefix ('C:') is a root and cannot be popped.
      if (out.length === 0 || /^[A-Za-z]:$/.test(out[out.length - 1])) return null
      out.pop()
    } else {
      out.push(seg)
    }
  }
  return lead + out.join('/')
}

/**
 * The .ipynb guardrail. Edit tools never touch notebook JSON directly - the
 * denial names the .py mirror so the agent self-corrects without any prompt
 * engineering. Reads pass through (extractWritePaths only matches write
 * tools), so agents can still inspect outputs and tracebacks.
 *
 * Paths are '..'-normalized BEFORE the repo prefix check - a raw string
 * prefix test would let '<root>/../../x.ipynb' pass as in-repo and the
 * mirror machinery would then read/write outside the repo.
 */
export function notebookWriteRedirect(
  toolName: string,
  input: unknown,
  repoRoot: string
): NotebookRedirect | null {
  const target = extractWritePaths(toolName, input)
    .map(toPosix)
    .find((p) => p.endsWith('.ipynb'))
  if (!target) return null

  const root = normalizePosix(toPosix(repoRoot).replace(/\/$/, '')) ?? ''
  const isAbs = target.startsWith('/') || /^[A-Za-z]:\//.test(target)
  const abs = normalizePosix(isAbs ? target : `${root}/${target}`)
  if (!root || !abs || !abs.startsWith(`${root}/`)) {
    return {
      notebookRelPath: null,
      mirrorRelPath: null,
      message:
        'Notebook .ipynb files are never edited directly in this workspace. Edit the notebook\'s .py mirror instead - mirrors live under .switchboard/notebooks/ in the repo the notebook belongs to.',
    }
  }

  const notebookRelPath = abs.slice(root.length + 1)
  const mirrorRelPath = mirrorRelPathFor(notebookRelPath)
  return {
    notebookRelPath,
    mirrorRelPath,
    message:
      `Notebook .ipynb files are never edited directly in this workspace. Edit ${mirrorRelPath} instead - ` +
      `it is the canonical .py mirror of ${notebookRelPath} and syncs back automatically. ` +
      `Read it first to see the cell markers, keep every [cellbridge_id=...] marker intact, and prefix markdown cell lines with "# ".`,
  }
}

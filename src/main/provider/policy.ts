/**
 * Shared permission policy for provider adapters.
 *
 * Both Claude and Codex enforce the same user-facing policy (Plan mode
 * denies mutations, Sandbox prompts, Accept-Edits auto-allows file tools,
 * Full-Access allows everything). Keeping the logic in one pure function
 * means any adapter can reuse it and there's a single place to update
 * policy rules.
 *
 * Not all tool names are identical across providers — Codex uses tool
 * names like `shell`, `edit`, etc. The policy normalizes via tool-name
 * equivalence sets (`EQUIV_EDIT_TOOLS`) so the same mode produces the same
 * behavior regardless of provider.
 */

import type { RuntimeMode } from '@shared/provider-events'

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
  // Codex equivalents — names the app-server uses
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

  // sandbox (default) — always prompt
  return 'prompt'
}

/**
 * Human-readable denial reason. Used by both adapters when they emit
 * `tool.denied` so the UI pill shows the same copy regardless of provider.
 */
export function denialMessage(mode: RuntimeMode, _toolName: string): string {
  if (mode === 'plan') {
    return 'Plan mode — tool execution is blocked. Use ExitPlanMode to propose your plan, or switch to Sandbox/Accept-Edits to execute.'
  }
  return 'Denied by permission policy'
}

/**
 * Context bridge between terminal panes and the active chat.
 *
 * Shared primitives for the ⌘L and ⌘K flows:
 *   - ⌘L: selects text in a terminal → appends a formatted context block
 *     to the active session's draft in the chat input.
 *   - ⌘K: opens a floating quick-prompt bar, optionally pre-filled with the
 *     current terminal selection, and sends the prompt directly via
 *     `providerApi.sendTurn` without going through the ChatInput textarea.
 *
 * The `formatTerminalContext` function is pure and unit-tested so the
 * exact wire format is locked down.
 */

import { getTerminalInstance } from './terminal-registry'
import { useTerminalStore } from '../stores/terminal-store'
import { useAgentStore } from '../stores/agent-store'
import { useDraftStore } from '../stores/draft-store'
import { agentShortLabel } from '@shared/types'
import { formatFileViewerContext, formatChatMessageContext } from './contextFormatters'

// Cap on captured terminal output so a runaway selection doesn't blow
// the agent's context window. Modern context windows are 200k+ so 4k was
// way too tight (truncated typical stack traces). 50k ≈ 12.5k tokens —
// still leaves >85% of the window free even on small models, but covers
// almost any practical terminal selection without truncation. If a user
// genuinely needs more, they can paste in chunks or use ⌘K instead.
const MAX_SELECTION_CHARS = 50_000

export interface TerminalContext {
  selection: string
  paneLabel: string
  command?: string
  cwd?: string
  timestamp: number
}

/**
 * Format a terminal selection into a chat-friendly context block.
 *
 * Pure function — inputs fully determine output. Tested in
 * tests/unit/context-bridge.test.ts.
 *
 * Example output:
 *   [from: backend @ 14:32 · npm run dev]
 *   ERROR: dbt test failed on stg_store_metrics
 *   stack trace line 1
 *
 * For long selections, wraps in a fenced code block and appends a
 * "<truncated>" notice so agents see the cap.
 */
export function formatTerminalContext(ctx: TerminalContext): string {
  // Force 24-hour so the context block reads cleanly regardless of locale
  // (otherwise en-US sessions get "04:32 pm" which confuses log parsers).
  const time = new Date(ctx.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const header = ctx.command
    ? `[from: ${ctx.paneLabel} @ ${time} · ${ctx.command}]`
    : `[from: ${ctx.paneLabel} @ ${time}]`

  let body = ctx.selection.trim()
  let truncated = false
  if (body.length > MAX_SELECTION_CHARS) {
    // Truncate at a line boundary so we don't split mid-line.
    const slice = body.slice(0, MAX_SELECTION_CHARS)
    const lastNl = slice.lastIndexOf('\n')
    body = (lastNl > MAX_SELECTION_CHARS * 0.7 ? slice.slice(0, lastNl) : slice)
    truncated = true
  }

  // Use a fenced block when the selection spans multiple lines — makes
  // it clearer to the agent that this is captured output, not a message.
  const isMultiLine = body.includes('\n')
  const wrapped = isMultiLine ? '```\n' + body + '\n```' : body
  const tail = truncated ? '\n_(output truncated)_' : ''

  return `${header}\n${wrapped}${tail}\n`
}

/**
 * Grab the current user selection from a xterm instance (if any).
 * Returns null when nothing is selected or the pane isn't live.
 */
export function getTerminalSelection(paneId: string): string | null {
  const inst = getTerminalInstance(paneId)
  if (!inst) return null
  const sel = inst.terminal.getSelection()
  return sel && sel.trim().length > 0 ? sel : null
}

/**
 * Build a TerminalContext for the given pane + selection, pulling pane
 * metadata (label/command/cwd) from the terminal-store.
 */
export function captureTerminalContext(
  sessionId: string,
  paneId: string,
  selection: string,
): TerminalContext {
  const pane = useTerminalStore.getState().getLayout(sessionId).panes[paneId]
  return {
    selection,
    paneLabel: pane?.label ?? 'terminal',
    command: pane?.command,
    cwd: pane?.cwd,
    timestamp: Date.now(),
  }
}

/**
 * Find the most relevant terminal selection for the current session.
 *
 * Priority:
 *   1. The active pane in the active window (most recent focus)
 *   2. Any pane with a selection (fallback)
 *
 * Returns the first match + the sessionId/paneId that owned it.
 * Returns null when no terminal has a selection.
 */
export function findActiveTerminalSelection(): {
  sessionId: string
  paneId: string
  selection: string
} | null {
  const agentSid = useAgentStore.getState().activeSessionId
  if (!agentSid) return null

  const layout = useTerminalStore.getState().getLayout(agentSid)
  // Try the active pane first
  const activeWindowId = layout.activeWindowId
  const activeWin = activeWindowId ? layout.windows[activeWindowId] : null
  const activePaneId = activeWin?.activePaneId

  const candidates: string[] = []
  if (activePaneId) candidates.push(activePaneId)
  // Then all other panes in row-major order
  for (const row of layout.rows) {
    for (const wid of row.windowIds) {
      const win = layout.windows[wid]
      if (!win) continue
      for (const pid of win.paneIds) {
        if (!candidates.includes(pid)) candidates.push(pid)
      }
    }
  }

  for (const pid of candidates) {
    const sel = getTerminalSelection(pid)
    if (sel) return { sessionId: agentSid, paneId: pid, selection: sel }
  }
  return null
}

/**
 * Walk up from an element to find the nearest `[data-context-source]`
 * ancestor. Returns its value (`'terminal' | 'file-viewer' | 'chat-message'`)
 * or null if there isn't one — caller should fall back to the legacy
 * terminal-only path.
 */
export function findContextSource(el: Element | null): string | null {
  let cur: Element | null = el
  while (cur) {
    const v = cur.getAttribute?.('data-context-source')
    if (v) return v
    cur = cur.parentElement
  }
  return null
}

/**
 * Read the currently-selected text from the document selection. Returns
 * an empty string when there's no selection (or the selection is empty
 * after trim).
 */
function getDomSelectionText(): string {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
  const text = sel?.toString() ?? ''
  return text
}

/**
 * Determine which line range a viewer selection covers. The viewer
 * highlight markup uses `<span class="line">` per Shiki's default — we
 * count line-spans in the start container's ancestry to derive the
 * 1-based line numbers. Best-effort; falls back to start=end=1 if the
 * structure doesn't match.
 */
function viewerSelectionLineRange(viewerRoot: Element): { start: number; end: number } {
  const sel = window.getSelection?.()
  if (!sel || sel.rangeCount === 0) return { start: 1, end: 1 }
  const range = sel.getRangeAt(0)
  const lines = Array.from(viewerRoot.querySelectorAll('.line, [data-line]'))
  if (lines.length === 0) return { start: 1, end: 1 }
  const findLineIndex = (node: Node): number => {
    let cur: Node | null = node
    while (cur && !(cur instanceof Element && (cur.classList.contains('line') || cur.hasAttribute('data-line')))) {
      cur = cur.parentNode
    }
    if (!cur) return 0
    const idx = lines.indexOf(cur as Element)
    return idx >= 0 ? idx + 1 : 1
  }
  return {
    start: findLineIndex(range.startContainer),
    end: findLineIndex(range.endContainer),
  }
}

/**
 * Unified ⌘L entry point. Inspects the focused/selection-anchor element
 * for `data-context-source` and dispatches to the appropriate formatter:
 *
 *   - 'terminal' → existing terminal selection flow
 *   - 'file-viewer' → `@<path>:<start>-<end>` pill + fenced code block
 *   - 'chat-message' → `> from <agent>: "..."` quoted block
 *   - null/unknown → fall back to terminal flow (preserves legacy ⌘L)
 *
 * Returns `true` if anything was appended, `false` otherwise.
 */
export function captureSelection(): boolean {
  const sel = typeof window !== 'undefined' ? window.getSelection?.() : null
  const anchor = sel?.anchorNode
  const anchorEl =
    anchor instanceof Element
      ? anchor
      : (anchor?.parentElement ?? null)
  const source = findContextSource(anchorEl)

  if (source === 'file-viewer') {
    const root = anchorEl?.closest('[data-context-source="file-viewer"]') as HTMLElement | null
    const path = root?.getAttribute('data-file-path') ?? ''
    const text = getDomSelectionText()
    if (!path || !text.trim()) return appendTerminalSelectionToDraft()
    const { start, end } = root ? viewerSelectionLineRange(root) : { start: 1, end: 1 }
    const sid = useAgentStore.getState().activeSessionId
    if (!sid) return false
    const block = formatFileViewerContext({
      path,
      startLine: start,
      endLine: end,
      content: text,
    })
    useDraftStore.getState().appendDraft(sid, block)
    return true
  }

  if (source === 'chat-message') {
    const text = getDomSelectionText()
    if (!text.trim()) return false
    const sid = useAgentStore.getState().activeSessionId
    if (!sid) return false
    const session = useAgentStore.getState().sessions.find((s) => s.id === sid)
    const agent = session ? agentShortLabel(session.type) : 'agent'
    const block = formatChatMessageContext({ agent, selection: text })
    useDraftStore.getState().appendDraft(sid, block)
    return true
  }

  // Default: legacy terminal flow.
  return appendTerminalSelectionToDraft()
}

/**
 * ⌘L implementation: capture the active terminal selection (if any) and
 * append it as a context block to the active session's draft. The user
 * then types their question and hits Send as normal.
 *
 * Returns `true` if a context block was appended, `false` otherwise
 * (caller can show a toast "select text in a terminal first").
 */
export function appendTerminalSelectionToDraft(): boolean {
  const found = findActiveTerminalSelection()
  if (!found) return false

  const ctx = captureTerminalContext(found.sessionId, found.paneId, found.selection)
  const block = formatTerminalContext(ctx)
  useDraftStore.getState().appendDraft(found.sessionId, block)
  return true
}

/**
 * ⌘K implementation: send a one-shot prompt to the active session,
 * optionally with the current terminal selection as prepended context.
 * Bypasses the ChatInput draft — message goes straight to the agent.
 *
 * Returns `true` on success, `false` if there's no active session to
 * send to.
 */
export async function sendQuickPrompt(
  prompt: string,
  opts?: { includeTerminalSelection?: boolean },
): Promise<boolean> {
  const agentSid = useAgentStore.getState().activeSessionId
  if (!agentSid) return false

  let message = prompt
  if (opts?.includeTerminalSelection) {
    const found = findActiveTerminalSelection()
    if (found) {
      const ctx = captureTerminalContext(found.sessionId, found.paneId, found.selection)
      message = formatTerminalContext(ctx) + '\n' + prompt
    }
  }

  // Runtime-mode from the active session so the prompt respects current policy.
  const session = useAgentStore.getState().sessions.find((s) => s.id === agentSid)
  const runtimeMode = session?.runtimeMode
  try {
    await window.api.provider?.sendTurn?.(agentSid, message, runtimeMode)
    return true
  } catch {
    return false
  }
}

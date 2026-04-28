/**
 * Slash command infrastructure for the chat input.
 *
 * A slash command is triggered when the user types `/` at the *start of a
 * line* in the chat textarea. The popover (`SlashCommandMenu`) lists
 * matching commands filtered by the trailing query. Selecting a command
 * runs its action (typically a store mutation or IPC call) and clears the
 * `/` prefix from the input.
 *
 * Registry is a typed array so tests + docs can stay honest; add commands
 * here rather than inline in UI code.
 */

import type { AgentStatus, ProviderSkill } from '@shared/types'

type RuntimeMode = 'plan' | 'sandbox' | 'accept-edits' | 'full-access'

/**
 * Context passed to every slash-command action. Keeping this in one place
 * makes it obvious which app surfaces a command can touch.
 */
export interface SlashCommandContext {
  sessionId: string | null
  /** Change the current session's runtime mode (fires through the adapter too). */
  setRuntimeMode: (mode: RuntimeMode) => void
  /** Clear all messages in the current session (local + nothing server-side). */
  clearMessages: () => void
  /** Archive the current conversation + navigate away. */
  archiveCurrent: () => void
  /** Open a small overlay listing all commands. */
  showHelp: () => void
  /** Attach an image via file picker (same flow as drag-drop/paste). */
  pickImage: () => void
  /** Interrupt the currently running turn. */
  interrupt: () => void
  /** Current agent status — used to gate commands that only make sense while running. */
  status?: AgentStatus
}

/**
 * Where this slash command came from. Determines how it's rendered (group
 * heading + colour) and what happens on select:
 *   - `switchboard`: a built-in client-side action (mode toggle, archive,
 *     etc.). `run()` is invoked.
 *   - `claude-code`: an agent-side command from the SDK's `init.commands`.
 *     Selecting it inserts `/<name> ` into the textarea so the user can
 *     fill in args, then send. The Claude SDK picks it up from the prompt.
 *   - `codex`: same as above but inserts `/<name> ` (Codex CLI also reads
 *     leading-slash commands from user input).
 */
export type SlashCommandSource = 'switchboard' | 'claude-code' | 'codex' | 'opencode'

export interface SlashCommand {
  /** `plan`, `sandbox`, etc. (no leading slash) */
  name: string
  /** Short description shown in the popover */
  description: string
  /** Where this command came from (default: 'switchboard') */
  source?: SlashCommandSource
  /** Optional argument hint shown after the name (e.g. "<file path>") */
  argumentHint?: string
  /**
   * Called when the user selects this command. For agent-source commands
   * this is omitted — selection just inserts the prefix into the textarea.
   */
  run?: (ctx: SlashCommandContext) => void
}

/**
 * Build SlashCommand entries from agent-provided skills. Pure — easy to
 * unit-test the merge order.
 */
export function skillsToSlashCommands(skills: ProviderSkill[]): SlashCommand[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description ?? `${s.source === 'codex' ? 'Codex' : 'Claude Code'} command`,
    source: s.source,
    ...(s.argumentHint ? { argumentHint: s.argumentHint } : {}),
  }))
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'plan',
    description: 'Switch to Plan mode (no tool execution, read-only discovery)',
    run: (ctx) => ctx.setRuntimeMode('plan'),
  },
  {
    name: 'sandbox',
    description: 'Switch to Sandbox mode (ask approval for every tool)',
    run: (ctx) => ctx.setRuntimeMode('sandbox'),
  },
  {
    name: 'edits',
    description: 'Switch to Accept-Edits mode (auto-approve file writes)',
    run: (ctx) => ctx.setRuntimeMode('accept-edits'),
  },
  {
    name: 'full',
    description: 'Switch to Full-Access mode (skip all approvals — be careful)',
    run: (ctx) => ctx.setRuntimeMode('full-access'),
  },
  {
    name: 'clear',
    description: 'Clear all messages in this conversation',
    run: (ctx) => ctx.clearMessages(),
  },
  {
    name: 'archive',
    description: 'Archive this conversation',
    run: (ctx) => ctx.archiveCurrent(),
  },
  {
    name: 'image',
    description: 'Attach an image from your filesystem',
    run: (ctx) => ctx.pickImage(),
  },
  {
    name: 'stop',
    description: 'Interrupt the current turn',
    run: (ctx) => ctx.interrupt(),
  },
  {
    name: 'help',
    description: 'Show all slash commands',
    run: (ctx) => ctx.showHelp(),
  },
]

/**
 * Pure function: does the text at `cursor` match a slash-command trigger?
 * Triggers only when `/` is the first non-whitespace character of the
 * current line — mid-line slashes (as in paths like `src/foo`) do NOT fire.
 *
 * Returns:
 *   - `{ query, rangeStart, rangeEnd }` when triggered
 *   - `null` otherwise
 *
 * Exported for unit testing — this is the tightest piece of logic in the
 * slash flow and worth locking down.
 */
export interface SlashTrigger {
  query: string
  rangeStart: number
  rangeEnd: number
}

export function detectSlashTrigger(text: string, cursorInput: number): SlashTrigger | null {
  const cursor = Math.max(0, Math.min(cursorInput, text.length))
  const lineStart = text.lastIndexOf('\n', Math.max(0, cursor - 1)) + 1
  const linePrefix = text.slice(lineStart, cursor)

  // Must be `/` followed by zero-or-more non-space chars.
  // Mid-line paths (`src/foo`) fail because their line-prefix starts with "src".
  const match = /^\/([^\s/]*)$/.exec(linePrefix)
  if (!match) return null

  return {
    query: match[1] ?? '',
    rangeStart: lineStart,
    rangeEnd: cursor,
  }
}

/**
 * Filter commands by query. Case-insensitive prefix match on `name`;
 * falls back to substring match on description if nothing matches the name.
 */
export function filterSlashCommands(query: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return commands
  const byName = commands.filter((c) => c.name.toLowerCase().startsWith(q))
  if (byName.length > 0) return byName
  return commands.filter((c) => c.description.toLowerCase().includes(q))
}

/**
 * Merge built-in Switchboard commands with the agent-provided skills.
 * Built-ins come first; agent skills follow in order. If an agent ships
 * a name that collides with a built-in (e.g. `/clear`), the built-in
 * wins — preserves the user's mental model that `/clear` always clears
 * the chat locally rather than firing some agent-defined action.
 */
export function mergeWithAgentSkills(
  builtIns: SlashCommand[],
  skills: ProviderSkill[],
): SlashCommand[] {
  const taken = new Set(builtIns.map((c) => c.name.toLowerCase()))
  const fromSkills = skillsToSlashCommands(skills).filter(
    (c) => !taken.has(c.name.toLowerCase()),
  )
  return [...builtIns, ...fromSkills]
}

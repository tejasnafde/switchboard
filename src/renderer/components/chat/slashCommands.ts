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
 *
 * Fires when the most recent `/` before the cursor is preceded by either
 * line-start or whitespace, AND there are no further `/` or whitespace
 * characters between that slash and the cursor. This means:
 *
 *   - `/plan` at line start → fires
 *   - `hi /plan` after a word → fires (so users discover skills mid-message)
 *   - `src/foo` (no preceding ws) → does NOT fire
 *   - `/etc/hosts` (nested slash) → does NOT fire
 *   - `~/Library/foo` (path) → does NOT fire
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
  if (cursor === 0) return null

  // Walk backwards from the cursor, looking for the nearest `/` candidate.
  // Bail if we hit whitespace before finding one (slash menu only tracks an
  // unbroken token immediately before the caret).
  let slashIdx = -1
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '/') { slashIdx = i; break }
    if (/\s/.test(ch)) return null
  }
  if (slashIdx === -1) return null

  // The `/` must be at line/text start, or preceded by whitespace —
  // otherwise it's part of a path like `src/foo` or a URL.
  if (slashIdx > 0) {
    const prev = text[slashIdx - 1]
    if (prev !== '\n' && !/\s/.test(prev)) return null
  }

  return {
    query: text.slice(slashIdx + 1, cursor),
    rangeStart: slashIdx,
    rangeEnd: cursor,
  }
}

/**
 * If `text` begins with a slash-command-shaped token (e.g. `/plan`,
 * `/commit foo`), return its parts. Used by `MessageBubble` to render
 * a leading `/cmd` as a `SkillChip` once the caller has confirmed the
 * name against the session's known-skill set.
 *
 * Pure regex with no membership check — callers gate chip rendering on
 * a registry lookup so typos like `/halp` don't masquerade as skills.
 */
export interface LeadingSlash {
  /** Just the command name, no slash. */
  name: string
  /** Everything after the command name (may include leading whitespace or args). */
  rest: string
}

const LEADING_SLASH_RE = /^\s*\/([a-zA-Z][\w-]*)(?=$|\s)/

export function parseLeadingSlashCommand(text: string): LeadingSlash | null {
  const m = text ? LEADING_SLASH_RE.exec(text) : null
  if (!m) return null
  return { name: m[1], rest: text.slice(m.index + m[0].length) }
}

/**
 * Claude Code's SDK wraps a slash-command invocation into an XML-tagged
 * blob when persisting to JSONL:
 *
 *   <command-message>deslop</command-message>
 *   <command-name>/deslop</command-name>
 *   <command-args>then /review</command-args>
 *
 * We never see this at compose time (the renderer ships a plain
 * `/cmd args` string), but it's what comes back when a session is
 * reloaded from disk. Extract the name + args so `MessageBubble` can
 * render the same SkillChip + rest UI it does for a fresh send.
 */
export function parseSlashCommandWrapper(text: string): LeadingSlash | null {
  if (!text || !text.startsWith('<command-message>')) return null
  const nameMatch = /<command-name>\s*\/?([a-zA-Z][\w-]*)\s*<\/command-name>/.exec(text)
  if (!nameMatch) return null
  const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
  const args = argsMatch ? argsMatch[1] : ''
  return { name: nameMatch[1], rest: args ? ` ${args}` : '' }
}

/**
 * Tokenize a string into alternating text + skill-mention segments.
 * Used by MessageBubble to chipify every `/<known-skill>` reference in
 * a sent message body, not just the leading one — so something like
 * `/deslop then /review` round-trips as two chips with the connector
 * text in between.
 *
 * A `/<name>` is chipified only when:
 *   - it's at start-of-string OR preceded by whitespace (path-y slashes
 *     like `src/foo` or `/etc/hosts` don't false-positive)
 *   - the name (lowercased) is in `known`
 *
 * Pure: returns a flat list of segments; rendering is left to the caller.
 */
export type SlashSegment =
  | { type: 'text'; value: string }
  | { type: 'skill'; name: string }

export function splitSkillMentions(text: string, known: Set<string>): SlashSegment[] {
  if (!text) return []
  const out: SlashSegment[] = []
  // Match `/cmd` only when preceded by start-of-string or whitespace.
  // The lookahead `(?=$|\s)` ensures we don't half-eat a longer token.
  const re = /(^|\s)\/([a-zA-Z][\w-]*)(?=$|\s)/g
  let cursor = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const [, lead, name] = m
    if (!known.has(name.toLowerCase())) continue
    // Push the leading whitespace + everything between the previous
    // chip and this one as a text segment.
    const textEnd = m.index + lead.length
    if (textEnd > cursor) {
      out.push({ type: 'text', value: text.slice(cursor, textEnd) })
    }
    out.push({ type: 'skill', name })
    cursor = textEnd + 1 + name.length // +1 for the slash
  }
  if (cursor < text.length) {
    out.push({ type: 'text', value: text.slice(cursor) })
  }
  return out
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

/**
 * Slash commands for the mobile composer.
 *
 * Two sources, as on the desktop: this client's own built-ins, and the skills
 * the live agent reports. Built-ins win a name collision, so `/clear` always
 * means "clear this feed" rather than whatever a skill of that name does.
 *
 * Pure, so the trigger and filter rules are testable without a composer.
 */
import type { ProviderSkill } from '@shared/types'
import type { RuntimeMode } from '@shared/provider-events'

/** What selecting an entry does. Actions are handled by the screen. */
export type SlashAction =
  | { kind: 'mode'; mode: RuntimeMode }
  | { kind: 'clear' }
  | { kind: 'stop' }
  | { kind: 'attach' }
  /** Agent skills are typed into the draft; the CLI parses the leading slash. */
  | { kind: 'insert'; text: string }

export interface SlashCommand {
  name: string
  description: string
  action: SlashAction
  /** Grouping label in the menu. */
  source: 'switchboard' | ProviderSkill['source']
  argumentHint?: string
}

/**
 * Mobile's own commands. Deliberately a subset of the desktop's: anything that
 * needs a pane, a worktree or a file viewer has nowhere to land on a phone.
 */
export const BUILT_IN_COMMANDS: SlashCommand[] = [
  { name: 'plan', description: 'Plan mode - read-only', action: { kind: 'mode', mode: 'plan' }, source: 'switchboard' },
  { name: 'sandbox', description: 'Sandbox mode - approvals required', action: { kind: 'mode', mode: 'sandbox' }, source: 'switchboard' },
  { name: 'edits', description: 'Accept edits automatically', action: { kind: 'mode', mode: 'accept-edits' }, source: 'switchboard' },
  { name: 'full', description: 'Full access - no prompts', action: { kind: 'mode', mode: 'full-access' }, source: 'switchboard' },
  { name: 'image', description: 'Attach an image', action: { kind: 'attach' }, source: 'switchboard' },
  { name: 'stop', description: 'Interrupt the current turn', action: { kind: 'stop' }, source: 'switchboard' },
  { name: 'clear', description: 'Clear this feed on the phone', action: { kind: 'clear' }, source: 'switchboard' },
]

/**
 * The typed slash query, or null when the menu should stay closed.
 *
 * Only fires for a slash that opens the WHOLE draft. A phone composer is one
 * line of thought, and matching mid-text would pop the menu over any path a
 * user types.
 */
export function detectSlash(draft: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(draft)
  return match ? match[1] : null
}

/** Agent skills as commands, minus any name a built-in already owns. */
export function skillCommands(skills: ProviderSkill[], builtIns = BUILT_IN_COMMANDS): SlashCommand[] {
  const taken = new Set(builtIns.map((c) => c.name.toLowerCase()))
  const seen = new Set<string>()
  const out: SlashCommand[] = []
  for (const skill of skills) {
    const name = skill.name.replace(/^\//, '')
    const key = name.toLowerCase()
    if (!name || taken.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      description: skill.description ?? '',
      action: { kind: 'insert', text: `/${name} ` },
      source: skill.source,
      argumentHint: skill.argumentHint,
    })
  }
  return out
}

/**
 * Commands matching the query, built-ins first.
 *
 * A prefix match ranks above a substring one, so typing `cl` offers `clear`
 * before something merely containing "cl".
 */
export function filterCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (q === '') return commands
  const scored: Array<{ cmd: SlashCommand; rank: number }> = []
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase()
    if (name.startsWith(q)) scored.push({ cmd, rank: 0 })
    else if (name.includes(q)) scored.push({ cmd, rank: 1 })
  }
  return scored.sort((a, b) => a.rank - b.rank).map((s) => s.cmd)
}

/** Built-ins then agent skills, ready to render. */
export function allCommands(skills: ProviderSkill[]): SlashCommand[] {
  return [...BUILT_IN_COMMANDS, ...skillCommands(skills)]
}

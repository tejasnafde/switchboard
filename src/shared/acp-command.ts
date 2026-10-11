/**
 * The launch config of a "local command" agent account: any program that
 * speaks the Agent Client Protocol on stdio. Stored in the account's
 * `config_json`; its env vars go in the encrypted env overlay like any
 * other account's.
 */
import { isRuntimeMode, type RuntimeMode } from './provider-events'

export interface AcpCommandConfig {
  /** A name looked up on PATH, or an absolute or `~/` path. */
  command: string
  args: string[]
  /** Folder the agent is started in; null means the chat's project folder. */
  cwd: string | null
}

const MAX_COMMAND_LENGTH = 1024
const MAX_ARGS = 64

/** The launch config in an account's `config_json`, or null when it has none or it is malformed. */
export function acpCommandConfig(configJson: unknown): AcpCommandConfig | null {
  if (!configJson || typeof configJson !== 'object') return null
  const raw = (configJson as { launch?: unknown }).launch
  if (!raw || typeof raw !== 'object') return null
  const { command, args, cwd } = raw as Record<string, unknown>
  if (typeof command !== 'string') return null
  const trimmed = command.trim()
  if (!trimmed || trimmed.length > MAX_COMMAND_LENGTH || /[\0\r\n]/.test(trimmed)) return null
  if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((a) => typeof a === 'string' && !a.includes('\0')))
    return null
  if (cwd !== null && cwd !== undefined && (typeof cwd !== 'string' || cwd.includes('\0'))) return null
  return { command: trimmed, args: args as string[], cwd: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null }
}

/**
 * Splits an arguments line into argv. Whitespace separates; single or double
 * quotes group, and a backslash escapes the next character outside single
 * quotes. Nothing is expanded: no globs, variables or `~`. Null when a quote
 * is left open.
 */
export function splitCommandArgs(line: string): string[] | null {
  const args: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
      started = true
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quote) return null
  if (started) args.push(current)
  return args
}

/**
 * The mode an account's new chats start in when nobody chose one (stored by
 * the Add agent dialog for agents not tested with Switchboard), or null.
 */
export function accountStartMode(configJson: unknown): RuntimeMode | null {
  if (!configJson || typeof configJson !== 'object') return null
  const mode = (configJson as { startMode?: unknown }).startMode
  return isRuntimeMode(mode) ? mode : null
}

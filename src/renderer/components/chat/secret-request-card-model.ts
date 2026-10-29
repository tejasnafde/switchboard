/**
 * Pure rules of the desktop secret request card (`SecretRequestCard.tsx`):
 * the footer and saved-line texts, URL splitting for the instructions, the
 * trim and size check on the value, and the provider-key note. Nothing here
 * keeps a value: every function takes it and returns at once.
 */
import { SECRET_VALUE_MAX_BYTES, type AgentSecretView, type SecretTtl } from '@shared/agent-secret-request'
import type { ApprovalResultOutcome } from '@shared/agent-approval-cards'

/** The eye button shows the value this long, then masks it again. */
export const SECRET_REVEAL_MS = 10_000

/** Marks the card's root element, so the window's own shortcut handler skips its keys. */
export const SECRET_CARD_ATTR = 'data-sb-secret-card'

/** Whether a key event comes from inside a secret card. */
export function isSecretCardKeyTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null
  return typeof el?.closest === 'function' && el.closest(`[${SECRET_CARD_ATTR}]`) != null
}

const TTL_TEXT: Record<SecretTtl, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '24h': '24 hours',
}

/** "Kept out of chat, in a private file this agent's commands can read for 24 hours[, on <machine>]." */
export function secretFooterText(ttl: SecretTtl, machineLabel?: string): string {
  const where = machineLabel ? `, on ${machineLabel}` : ''
  return `Kept out of chat, in a private file this agent's commands can read for ${TTL_TEXT[ttl]}${where}.`
}

export const SECRET_TRIMMED_TEXT = 'Trimmed spaces at the end'

/** Hours left, then minutes under an hour ("23 h left", "47 min left"); null once it is past. */
export function secretTimeLeftText(expiresAt: number, now: number): string | null {
  const ms = expiresAt - now
  if (ms <= 0) return null
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} min left`
  return `${Math.floor(minutes / 60)} h left`
}

/**
 * Trailing spaces and tabs, and one trailing newline, go. A value pasted from
 * a terminal or a text file often carries them, and a key with them fails.
 */
export function trimSecretValue(raw: string): { value: string; trimmed: boolean } {
  const value = raw.replace(/[ \t]*(?:\r?\n)?[ \t]*$/, '')
  return { value, trimmed: value.length !== raw.length }
}

/** UTF-8 byte length, counted without copying the value into a buffer. A lone surrogate counts as U+FFFD. */
export function utf8ByteLength(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** Save is on only for a value of 1 byte to 16 KiB after the trim. */
export function secretValueSavable(raw: string): boolean {
  const bytes = utf8ByteLength(trimSecretValue(raw).value)
  return bytes > 0 && bytes <= SECRET_VALUE_MAX_BYTES
}

export type InstructionPart = { kind: 'text'; text: string } | { kind: 'url'; url: string; host: string; rest: string }

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

/**
 * Plain text, with each http(s) URL split into its host (shown bold) and the
 * rest of the path. The scheme and any user part are not shown; the full URL
 * is in the confirm before it opens. A URL that does not parse stays text.
 */
export function splitInstructionUrls(text: string): InstructionPart[] {
  const parts: InstructionPart[] = []
  let last = 0
  const push = (t: string) => {
    if (!t) return
    const prev = parts[parts.length - 1]
    if (prev?.kind === 'text') prev.text += t
    else parts.push({ kind: 'text', text: t })
  }
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const raw = match[0].replace(TRAILING_PUNCTUATION, '')
    push(text.slice(last, start))
    last = start + raw.length
    const parsed = URL.canParse(raw) ? new URL(raw) : null
    if (!parsed || !parsed.host) {
      push(raw)
      continue
    }
    const afterScheme = raw.indexOf('//') + 2
    const authorityEnd = raw.slice(afterScheme).search(/[/?#]/)
    const rest = authorityEnd < 0 ? '' : raw.slice(afterScheme + authorityEnd)
    parts.push({ kind: 'url', url: parsed.href, host: parsed.host, rest })
  }
  push(text.slice(last))
  return parts
}

/** Env names of the provider keys Switchboard keeps for its own accounts. */
export const PROVIDER_KEY_NAMES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENCODE_API_KEY',
  'NVIDIA_API_KEY',
]

export const PROVIDER_KEY_NOTE = "Switchboard does not need this. Only this agent's commands get it."

/** Whether the card asks for a key with the name of one Switchboard holds ("Anthropic API key" counts). */
export function asksForProviderKey(name: string, title: string): boolean {
  const titleAsName = title.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return PROVIDER_KEY_NAMES.some((key) => name === key || `_${titleAsName}_`.includes(`_${key}_`))
}

export type SecretLineState =
  | { kind: 'saved'; expiresAt: number | null; secretId: string | null }
  | { kind: 'declined' }
  | { kind: 'expired' }
  | { kind: 'deleted' }

/**
 * The collapsed line of a closed card, from its result row and the chat's
 * saved secrets. `secrets` is null until the list loads (or when it cannot):
 * a saved card then shows "Saved NAME" with no time and no buttons.
 */
export function secretLineState(
  outcome: ApprovalResultOutcome,
  cardId: string,
  secrets: readonly AgentSecretView[] | null,
  now: number,
): SecretLineState {
  if (outcome === 'declined' || outcome === 'dismissed') return { kind: 'declined' }
  if (outcome !== 'done') return { kind: 'expired' }
  if (!secrets) return { kind: 'saved', expiresAt: null, secretId: null }
  const row = secrets.find((s) => s.cardId === cardId)
  if (!row) return { kind: 'expired' }
  if (row.status === 'deleted') return { kind: 'deleted' }
  if (row.status === 'expired' || row.expiresAt <= now) return { kind: 'expired' }
  return { kind: 'saved', expiresAt: row.expiresAt, secretId: row.id }
}

/** The secret's name from its result row title (`Secret NAME`). */
export function secretNameFromResultTitle(title: string): string {
  return title.startsWith('Secret ') ? title.slice('Secret '.length) : title
}

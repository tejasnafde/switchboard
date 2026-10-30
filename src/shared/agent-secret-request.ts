/**
 * `request_secret`: an agent asks the user for a secret, the user types it in
 * a card, and Switchboard writes it to a private file for that chat only
 * (`main/secrets/secret-store.ts`). The agent gets the path and the env var
 * that points at the folder, never the value. Pure rules shared by the MCP
 * tool, the broker and the clients.
 */
import type { SettingReader } from './limit-resume'
import type { ApprovalResultOutcome, ApprovalResultRow } from './agent-approval-cards'

/**
 * Staged flag `agent_secret_request`. Off until the card ships on every
 * surface. `SB_AGENT_SECRET_REQUEST=1` in Switchboard's own env, or the labs
 * setting, turns it on for testing.
 */
export const AGENT_SECRET_REQUEST_ENABLED = false
export const AGENT_SECRET_REQUEST_LABS_SETTING = 'labs.agent_secret_request'

export function agentSecretRequestEnabled(env: NodeJS.ProcessEnv, getSetting: SettingReader): boolean {
  return (
    AGENT_SECRET_REQUEST_ENABLED ||
    env.SB_AGENT_SECRET_REQUEST === '1' ||
    getSetting(AGENT_SECRET_REQUEST_LABS_SETTING) === 'true'
  )
}

export const REQUEST_SECRET_TOOL = 'request_secret'
/** Set at session start for every agent kind. Holds a folder path, never a value. */
export const SECRETS_DIR_ENV = 'SWITCHBOARD_SECRETS_DIR'
/** Card ids. The card lives in the approval card book, but only the secret answer channel saves it. */
export const SECRET_CARD_ID_PREFIX = 'sbsec_'

export const SECRET_TTLS = ['15m', '1h', '4h', '24h'] as const
export type SecretTtl = (typeof SECRET_TTLS)[number]
export const SECRET_TTL_MS: Record<SecretTtl, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
}
/** Each "Extend" sets the expiry to this long from now. */
export const SECRET_EXTEND_MS = 24 * 60 * 60_000

/** How long the user took to answer a card, as the analytics bucket (`secret_request.answered`). */
export const SECRET_ANSWER_SECONDS_BUCKETS = ['under_30s', '30s_2m', '2m_10m', '10m_1h', 'over_1h'] as const
export type SecretAnswerSecondsBucket = (typeof SECRET_ANSWER_SECONDS_BUCKETS)[number]

export function secretAnswerSecondsBucket(ms: number): SecretAnswerSecondsBucket {
  const s = ms / 1000
  if (s < 30) return 'under_30s'
  if (s < 120) return '30s_2m'
  if (s < 600) return '2m_10m'
  if (s < 3600) return '10m_1h'
  return 'over_1h'
}

/** The how-many-th Extend of one secret, as the analytics bucket (`secret_request.extended`). */
export function secretExtendCountBucket(count: number): '1' | '2' | '3' | 'more' {
  return count <= 1 ? '1' : count === 2 ? '2' : count === 3 ? '3' : 'more'
}

/** At most this many open secret cards per chat, and this many requests per window. */
export const SECRET_OPEN_CARD_CAP = 3
export const SECRET_RATE_LIMIT = 5
export const SECRET_RATE_WINDOW_MS = 10 * 60_000

export const SECRET_NAME_RULE = /^[A-Z][A-Z0-9_]{1,63}$/
export const SECRET_TITLE_MAX = 80
export const SECRET_INSTRUCTIONS_MAX = 1500
export const SECRET_VALUE_MAX_BYTES = 16 * 1024

/** Values with fewer characters (code points) are not masked: they hit too often. */
export const SECRET_MATCH_MIN_CHARS = 8

/** Whether the masker matches `value`. The card warns when it does not. */
export function secretValueMaskable(value: string): boolean {
  return [...value].length >= SECRET_MATCH_MIN_CHARS
}

/** What the card shows (`request.opened.secretRequest`). Never a value. */
export interface SecretRequestCard {
  name: string
  title: string
  instructions: string
  ttl: SecretTtl
  /** The SSH machine whose backend keeps the file; the desktop fills it from its routing. */
  machineLabel?: string
}

/** The stored plan of an `sbsec_` card. Holds no value. */
export interface SecretRequestPlan {
  kind: 'secret-request'
  card: SecretRequestCard
}

export function isSecretRequestPlan(plan: unknown): plan is SecretRequestPlan {
  return !!plan && typeof plan === 'object' && (plan as { kind?: unknown }).kind === 'secret-request'
}

export function isSecretCardId(requestId: unknown): boolean {
  return typeof requestId === 'string' && requestId.startsWith(SECRET_CARD_ID_PREFIX)
}

/** The plain-text `detail` for clients that do not render the card, and for push. No title, no instructions. */
export const SECRET_REQUEST_DETAIL = 'An agent asks for a secret. Answer it in Switchboard on your computer.'

/**
 * C0 and C1 controls, and the bidi marks, embeddings, overrides and isolates
 * that can make a card read differently from what it says. `\n` and `\t`
 * are allowed in the instructions only.
 */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const UNSAFE_INSTRUCTIONS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/

export type SecretArgsCheck = { ok: true; card: SecretRequestCard } | { ok: false; message: string }

/** The tool's arguments, refused with the rule in the message. Any unknown field is refused. */
export function checkSecretRequestArgs(args: Record<string, unknown>): SecretArgsCheck {
  const extra = Object.keys(args).filter((k) => !['name', 'title', 'instructions', 'ttl'].includes(k))
  if (extra.length > 0)
    return { ok: false, message: `Unknown field ${extra.join(', ')}. Pass only name, title, instructions and ttl.` }
  const name = typeof args.name === 'string' ? args.name : ''
  if (!SECRET_NAME_RULE.test(name))
    return { ok: false, message: 'name must match ^[A-Z][A-Z0-9_]{1,63}$, for example TAILSCALE_AUTHKEY.' }
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (title.length < 1 || title.length > SECRET_TITLE_MAX || UNSAFE_TEXT.test(title))
    return {
      ok: false,
      message: `title must be one line of 1 to ${SECRET_TITLE_MAX} characters, with no control or direction characters.`,
    }
  const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : ''
  if (
    instructions.length < 1 ||
    instructions.length > SECRET_INSTRUCTIONS_MAX ||
    UNSAFE_INSTRUCTIONS.test(instructions)
  )
    return {
      ok: false,
      message: `instructions must be 1 to ${SECRET_INSTRUCTIONS_MAX} characters of plain text. Only new lines and tabs are allowed as control characters.`,
    }
  const ttl = args.ttl === undefined ? '24h' : args.ttl
  if (!SECRET_TTLS.includes(ttl as SecretTtl))
    return { ok: false, message: `ttl must be one of ${SECRET_TTLS.join(', ')}. The default is 24h.` }
  return { ok: true, card: { name, title, instructions, ttl: ttl as SecretTtl } }
}

export function secretQueuedText(name: string, requestId: string): string {
  return [
    `Asked the user for ${name} (card ${requestId}). When they answer, you get a message from Switchboard.`,
    'Do not ask again. Do not ask the user to paste it in chat.',
  ].join(' ')
}

export const SECRET_PLAN_MODE_REFUSAL = 'Secrets are not asked in plan mode. Put the step in your plan.'

/** The result turn after a save. Names the path and the env var, never the value. */
export function secretSavedText(input: {
  name: string
  file: string
  expiresAt: number
  machine?: string
  planMode?: boolean
}): string {
  const expires = new Date(input.expiresAt).toISOString()
  return [
    `Saved ${input.name}${input.machine ? ` on ${input.machine}` : ''}.`,
    `file: ${input.file}`,
    `env: ${SECRETS_DIR_ENV}`,
    `name: ${input.name}`,
    `expiresAt: ${expires}`,
    `Read it only inside a command. In bash: --authkey "$(cat "$${SECRETS_DIR_ENV}/${input.name}")". In PowerShell: --authkey (Get-Content -Raw "$env:${SECRETS_DIR_ENV}/${input.name}").`,
    'Never print it, echo it, write it to a file in the repo, or put it in a commit, a log or a message.',
    `It stays until ${expires} or until this chat is archived; a Stop does not remove it.`,
    `If reading it fails later, it expired or the user deleted it: call ${REQUEST_SECRET_TOOL} again.`,
    ...(input.planMode
      ? ['The chat is in plan mode now, so commands that read it are refused until the mode changes.']
      : []),
  ].join('\n')
}

export function secretDeclinedText(name: string): string {
  return [
    `The user declined to give ${name}.`,
    `Continue without it, or ask the user in chat what to do. Do not call ${REQUEST_SECRET_TOOL} again for ${name} in this turn.`,
  ].join(' ')
}

export function secretClosedText(name: string, why: 'expired' | 'stopped' | 'withdrawn'): string {
  if (why === 'withdrawn') return `You withdrew the request for ${name}. Nothing was saved.`
  if (why === 'expired')
    return `Nobody answered the request for ${name} within 7 days, so it closed and nothing was saved.`
  return `The chat ended before the user answered, so ${name} was not saved.`
}

/** Backend capability: it serves `AgentSecretChannels` (`ws-protocol` BACKEND_CAPABILITIES). */
export const AGENT_SECRET_REQUEST_CAPABILITY = 'agent_secret_request_v1'

/** The system row a turn gets when a saved secret showed up in its output and was masked. */
export const SECRET_MASKED_TEXT = 'A saved secret appeared in the output and was masked. The agent saw it.'

/** The desktop's answer to a secret card. Exactly one of these shapes, nothing else. */
export type AgentSecretAnswer = { save: string } | { decline: true }

/** Whether `answer` is exactly `{ save: string }` or `{ decline: true }`, with no other key. */
export function isAgentSecretAnswer(answer: unknown): answer is AgentSecretAnswer {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
  const keys = Object.keys(answer)
  if (keys.length !== 1) return false
  const o = answer as Record<string, unknown>
  if (keys[0] === 'save') return typeof o.save === 'string'
  return keys[0] === 'decline' && o.decline === true
}

/**
 * One saved secret of a chat, as `agent-secret:list` answers it. Metadata
 * only: never the value, its length or a hash. `status` is `expired` when the
 * file went at or after its expiry, `deleted` when it went before (Delete
 * now, an archive, or a newer save of the same name).
 */
export interface AgentSecretView {
  id: string
  name: string
  cardId: string
  createdAt: number
  expiresAt: number
  deletedAt: number | null
  status: 'live' | 'expired' | 'deleted'
}

export function agentSecretStatus(
  row: { expiresAt: number; deletedAt: number | null },
  now: number,
): AgentSecretView['status'] {
  if (row.deletedAt === null) return row.expiresAt > now ? 'live' : 'expired'
  return row.deletedAt >= row.expiresAt ? 'expired' : 'deleted'
}

export type SecretLineState =
  | { kind: 'saved'; expiresAt: number | null; secretId: string | null }
  | { kind: 'declined' }
  | { kind: 'expired' }
  | { kind: 'deleted' }

/**
 * The collapsed line of a closed card, from its result row and the chat's
 * saved secrets. `secrets` is null until the list loads, or when it cannot
 * be read (a phone may not call the list): a saved card then shows
 * "Saved NAME" with no time and no buttons.
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

/** The card header on every surface. The agent asked, never Switchboard. */
export const SECRET_CARD_HEADER = 'Asked by the agent in this chat'
/** The phone card's line above Decline. Phones never take a value in v1. */
export const SECRET_PHONE_ANSWER_TEXT = 'Answer this on your computer.'

/**
 * A secret result row as the one line a phone shows: "Saved NAME",
 * "Declined NAME" or "NAME expired". Phones cannot read the saved list, so a
 * saved line has no time left and no buttons. Null for any other row.
 */
export function secretResultLine(
  row: ApprovalResultRow,
): { kind: 'saved' | 'declined' | 'expired'; name: string; text: string } | null {
  if (!isSecretCardId(row.requestId)) return null
  const name = secretNameFromResultTitle(row.title)
  const kind = secretLineState(row.outcome, row.requestId, null, 0).kind
  if (kind === 'saved') return { kind, name, text: `Saved ${name}` }
  if (kind === 'declined') return { kind, name, text: `Declined ${name}` }
  return { kind: 'expired', name, text: `${name} expired` }
}

export type SecretInstructionPart = { kind: 'text'; text: string } | { kind: 'host'; host: string; rest: string }

const PHONE_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const PHONE_TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/
const PHONE_HOST = /^(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(?::\d{1,5})?$/

/**
 * The instructions as plain text with each http(s) URL's host split out to
 * show bold, for the phones: no URL parser (the phone runtimes do not all
 * have one), no scheme and no user part shown, and nothing is a link. A URL
 * whose host is not a plain name stays text.
 */
export function secretInstructionParts(text: string): SecretInstructionPart[] {
  const parts: SecretInstructionPart[] = []
  let last = 0
  const push = (t: string) => {
    if (!t) return
    const prev = parts[parts.length - 1]
    if (prev?.kind === 'text') prev.text += t
    else parts.push({ kind: 'text', text: t })
  }
  for (const match of text.matchAll(PHONE_URL_PATTERN)) {
    const start = match.index ?? 0
    const raw = match[0].replace(PHONE_TRAILING_PUNCTUATION, '')
    push(text.slice(last, start))
    last = start + raw.length
    const afterScheme = raw.slice(raw.indexOf('//') + 2)
    const end = afterScheme.search(/[/?#]/)
    const authority = end < 0 ? afterScheme : afterScheme.slice(0, end)
    const host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase()
    if (!PHONE_HOST.test(host)) {
      push(raw)
      continue
    }
    parts.push({ kind: 'host', host, rest: end < 0 ? '' : afterScheme.slice(end) })
  }
  push(text.slice(last))
  return parts
}

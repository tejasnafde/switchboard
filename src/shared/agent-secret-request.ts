/**
 * `request_secret`: an agent asks the user for a secret, the user types it in
 * a card, and Switchboard writes it to a private file for that chat only
 * (`main/secrets/secret-store.ts`). The agent gets the path and the env var
 * that points at the folder, never the value. Pure rules shared by the MCP
 * tool, the broker and the clients.
 */
import type { SettingReader } from './limit-resume'

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

/** At most this many open secret cards per chat, and this many requests per window. */
export const SECRET_OPEN_CARD_CAP = 3
export const SECRET_RATE_LIMIT = 5
export const SECRET_RATE_WINDOW_MS = 10 * 60_000

export const SECRET_NAME_RULE = /^[A-Z][A-Z0-9_]{1,63}$/
export const SECRET_TITLE_MAX = 80
export const SECRET_INSTRUCTIONS_MAX = 1500
export const SECRET_VALUE_MAX_BYTES = 16 * 1024

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

/**
 * The pull request tools of the Switchboard MCP server: two reads that run
 * without asking and three writes that each open one Switchboard approval
 * card. Approve, request changes and merge are deliberately absent: those
 * stay the user's.
 *
 * Every tool works only on pull requests linked to the calling chat, and
 * every refusal is tool output with `isError`, never a throw, so the model
 * reads the reason instead of retrying a transport failure.
 */
import {
  AGENT_REPLY_MAX_CHARS,
  checkReplyText,
  hostWriteDetail,
  hostWriteGate,
  withViaMarker,
  type HostWriteCard,
} from '@shared/agent-host-writes'
import { findPullRequestUrls, normalizePrRef } from '@shared/pull-request-links'
import type { PrWriteDone } from '@shared/pull-request-writes'
import {
  HOST_CAPABILITIES,
  PR_HOST_LABEL,
  prKey,
  type PrConversation,
  type PrDetail,
  type PrRef,
  type PrResult,
} from '@shared/pull-requests'
import type { RuntimeEvent, RuntimeMode } from '@shared/provider-events'
import { createMainLogger } from '../logger'
import type { AgentApprovalBroker, AgentApprovalOutcome } from './agent-approvals'
import type { AgentWriteBudget } from './agent-write-budget'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'

const log = createMainLogger('mcp:pr-tools')

export const PR_STATUS_TOOL = 'get_pr_status'
export const PR_CONVERSATIONS_TOOL = 'list_pr_conversations'
export const PR_REPLY_TOOL = 'reply_to_conversation'
export const PR_RESOLVE_TOOL = 'resolve_conversation'
export const PR_RERUN_TOOL = 'rerun_check'

/** What the tools need from Reviews. `PullRequestService` satisfies the reads and writes. */
export interface AgentPullRequestAccess {
  /** PRs linked to the chat (root conversation), oldest link first. */
  linkedPrs(chatId: string): PrRef[]
  detail(ref: PrRef): Promise<PrResult<PrDetail>>
  conversations(ref: PrRef): Promise<PrResult<PrConversation[]>>
  reply(ref: PrRef, input: { conversationId: string; body: string }): Promise<PrResult<PrWriteDone>>
  setResolved(ref: PrRef, input: { conversationId: string }, resolved: boolean): Promise<PrResult<PrWriteDone>>
  rerunCheck(ref: PrRef, input: { checkId: string }): Promise<PrResult<PrWriteDone>>
}

let registeredAccess: AgentPullRequestAccess | null = null

/** Set once by the Reviews IPC module, on every host that has Reviews. */
export function setAgentPullRequestAccess(access: AgentPullRequestAccess | null): void {
  registeredAccess = access
}

export function agentPullRequestAccess(): AgentPullRequestAccess | null {
  return registeredAccess
}

export interface PrToolContext {
  /** The id the calling session started under; events go out on it. */
  threadId: string
  /** The chat's root id, which links and the budget are keyed by. */
  chatId: string
  agentLabel: string
  runtimeMode(): RuntimeMode
  publish(event: RuntimeEvent): void
  approvals: Pick<AgentApprovalBroker, 'ask'>
  budget: Pick<AgentWriteBudget, 'take'>
  /** Null on a backend without Reviews. */
  pullRequests: AgentPullRequestAccess | null
}

const QUOTE_MAX_CHARS = 600
const COMMENT_MAX_CHARS = 3_000
const DESCRIPTION_MAX_CHARS = 4_000

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (cut, ${text.length} characters in all)` : text
}

function prLabel(ref: PrRef): string {
  return `${ref.name} #${ref.number}`
}

function describeLinks(refs: PrRef[]): string {
  return refs.map((r) => `${PR_HOST_LABEL[r.host]} ${r.owner}/${r.name} #${r.number}`).join(', ')
}

const NO_LINK =
  'No pull request is linked to this chat, so there is nothing these tools may read or write. ' +
  'The user links one from Reviews ("Link to chat"), and a pull request of this project links itself ' +
  'once its URL appears in the chat.'

/**
 * The linked PR the agent means: `pr` as a number, "#612" or a URL, or omitted
 * when exactly one is linked. Never a PR outside the links.
 */
export function pickLinkedPr(linked: PrRef[], pr: unknown): { ok: true; ref: PrRef } | { ok: false; message: string } {
  if (linked.length === 0) return { ok: false, message: NO_LINK }
  if (pr === undefined || pr === null || pr === '') {
    if (linked.length === 1) return { ok: true, ref: linked[0] }
    return { ok: false, message: `Several pull requests are linked to this chat (${describeLinks(linked)}). Pass "pr" with the one you mean.` }
  }
  const text = String(pr).trim()
  const url = findPullRequestUrls(text)[0]
  if (url) {
    const hit = linked.find((r) => prKey(normalizePrRef(r)) === prKey(url))
    return hit ? { ok: true, ref: hit } : { ok: false, message: `${text} is not linked to this chat. Linked: ${describeLinks(linked)}.` }
  }
  const number = /^#?(\d{1,9})$/.exec(text)?.[1]
  if (!number) return { ok: false, message: `"${text}" is not a pull request number or URL. Linked: ${describeLinks(linked)}.` }
  const hits = linked.filter((r) => r.number === Number(number))
  if (hits.length === 1) return { ok: true, ref: hits[0] }
  if (hits.length === 0) return { ok: false, message: `#${number} is not linked to this chat. Linked: ${describeLinks(linked)}.` }
  return { ok: false, message: `More than one linked pull request is #${number}. Pass its URL instead.` }
}

function location(c: PrConversation): string | null {
  if (!c.path) return null
  return c.line !== null ? `${c.path}:${c.line}` : c.path
}

function quoteOf(c: PrConversation): HostWriteCard['quote'] {
  const first = c.comments[0]
  return first ? { author: first.author.login, body: cap(first.body, QUOTE_MAX_CHARS) } : null
}

const PR_ARG = {
  type: ['string', 'number'],
  description: 'The pull request: its number, "#612" or its URL. Optional when exactly one pull request is linked to this chat.',
}

type Picked = { ref: PrRef; access: AgentPullRequestAccess }

export function buildPrTools(ctx: PrToolContext): McpTool[] {
  const pick = (args: Record<string, unknown>): Picked | McpToolResult => {
    const access = ctx.pullRequests
    if (!access) return toolText('Reviews is not available on this backend, so pull request tools cannot run here.', true)
    const picked = pickLinkedPr(access.linkedPrs(ctx.chatId), args.pr)
    return picked.ok ? { ref: picked.ref, access } : toolText(picked.message, true)
  }

  /** Plan mode refuses before anything is read. */
  const refusePlan = (toolName: string): McpToolResult | null => {
    const mode = ctx.runtimeMode()
    if (hostWriteGate(mode) !== 'deny') return null
    const reason = 'Plan mode - nothing is posted to a pull request. Tell the user what you would post, or ask them to switch modes.'
    ctx.publish({ type: 'tool.denied', threadId: ctx.threadId, toolName: `mcp__switchboard__${toolName}`, reason, mode })
    return toolText(reason, true)
  }

  const conversationOf = async (p: Picked, id: unknown): Promise<PrConversation | McpToolResult> => {
    if (typeof id !== 'string' || !id.trim()) return toolText(`No conversationId given. Call ${PR_CONVERSATIONS_TOOL} for the ids.`, true)
    const read = await p.access.conversations(p.ref)
    if (!read.ok) return toolText(read.error.message, true)
    const found = read.data.find((c) => c.id === id.trim())
    return found ?? toolText(`No conversation ${id} on ${prLabel(p.ref)}. Call ${PR_CONVERSATIONS_TOOL} for the current ids.`, true)
  }

  /** Charges the budget, then opens the card: a write counts once it would interrupt the user. */
  const ask = async (toolName: string, card: HostWriteCard, signal: AbortSignal): Promise<AgentApprovalOutcome | McpToolResult> => {
    const budget = ctx.budget.take(ctx.chatId)
    if (!budget.ok) return toolText(budget.message, true)
    return ctx.approvals.ask({
      threadId: ctx.threadId,
      toolName: `mcp__switchboard__${toolName}`,
      detail: hostWriteDetail(card),
      hostWrite: card,
      signal,
    })
  }

  const declined = (outcome: Extract<AgentApprovalOutcome, { decision: 'deny' }>): McpToolResult => {
    if (outcome.reason === 'expired') {
      return toolText('The approval card expired without an answer, so nothing was posted. Ask the user before trying again.', true)
    }
    if (outcome.reason === 'stopped') return toolText('The session stopped before the user answered. Nothing was posted.', true)
    return toolText('The user declined. Nothing was posted. Ask them what they want instead of retrying.', true)
  }

  const card = (ref: PrRef, action: HostWriteCard['action'], rest: Partial<HostWriteCard>): HostWriteCard => ({
    action,
    agentLabel: ctx.agentLabel,
    host: ref.host,
    prLabel: prLabel(ref),
    url: null,
    location: null,
    quote: null,
    maxChars: AGENT_REPLY_MAX_CHARS,
    ...rest,
  })

  const statusTool: McpTool = {
    name: PR_STATUS_TOOL,
    description: [
      'Status of a pull request linked to this chat: state, branches, head commit, checks (with the ids rerun_check takes),',
      'reviews and approvals, open conversation count and what blocks the merge. Read-only; runs without asking.',
      'Approving, requesting changes and merging are the user\'s, not yours; no tool does them.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: { pr: PR_ARG }, additionalProperties: false },
    annotations: { title: 'Pull request status', readOnlyHint: true, openWorldHint: true },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      const read = await p.access.detail(p.ref)
      if (!read.ok) return toolText(read.error.message, true)
      const d = read.data
      const canRerun = HOST_CAPABILITIES[d.ref.host].rerunChecks
      return toolText(JSON.stringify({
        pr: `${PR_HOST_LABEL[d.ref.host]} ${d.ref.owner}/${d.ref.name} #${d.ref.number}`,
        url: d.url,
        title: d.title,
        state: d.state,
        draft: d.draft,
        author: d.author.login,
        viewerIsAuthor: d.viewer.isAuthor,
        sourceBranch: d.sourceBranch,
        targetBranch: d.targetBranch,
        headSha: d.headSha,
        checks: d.checks,
        checkList: d.checkList.map((c) => ({
          id: c.id,
          name: c.name,
          state: c.state,
          description: c.description,
          url: c.url,
          canRerun: canRerun && c.state === 'failure' && c.rerunId !== null,
        })),
        approvals: d.approvals,
        reviewers: d.reviewers.map((r) => ({ login: r.person.login, state: r.state, requested: r.requested })),
        unresolvedConversations: d.unresolvedConversations,
        mergeBlockers: d.mergeBlockers.map((b) => b.label),
        description: cap(d.description, DESCRIPTION_MAX_CHARS),
      }, null, 2))
    },
  }

  const conversationsTool: McpTool = {
    name: PR_CONVERSATIONS_TOOL,
    description: [
      'The review conversations (inline threads) on a pull request linked to this chat, with each one\'s id,',
      'file and line, and its comments. Open ones only unless includeResolved is true. Read-only; runs without asking.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { pr: PR_ARG, includeResolved: { type: 'boolean', description: 'Also list resolved conversations.' } },
      additionalProperties: false,
    },
    annotations: { title: 'Pull request conversations', readOnlyHint: true, openWorldHint: true },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      const read = await p.access.conversations(p.ref)
      if (!read.ok) return toolText(read.error.message, true)
      const list = read.data.filter((c) => args.includeResolved === true || !c.resolved)
      if (list.length === 0) return toolText(`${prLabel(p.ref)} has no ${args.includeResolved === true ? '' : 'open '}review conversations.`)
      return toolText(JSON.stringify(list.map((c) => ({
        id: c.id,
        location: location(c),
        resolved: c.resolved,
        outdated: c.outdated,
        comments: c.comments.map((m) => ({ author: m.author.login, body: cap(m.body, COMMENT_MAX_CHARS), at: new Date(m.createdAt).toISOString() })),
      })), null, 2))
    },
  }

  const replyTool: McpTool = {
    name: PR_REPLY_TOOL,
    description: [
      'Reply to a review conversation on a pull request linked to this chat, and optionally resolve it.',
      'The user sees your reply in a Switchboard approval card, can edit it, and decides whether it is posted',
      'and whether the conversation is resolved. It is posted as the user, ending with a "via Switchboard" line.',
      `Keep it short and specific: what changed and where (commit, file, test). At most ${AGENT_REPLY_MAX_CHARS} characters.`,
      'Refused in plan mode.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: PR_ARG,
        conversationId: { type: 'string', description: `The conversation id from ${PR_CONVERSATIONS_TOOL}.` },
        text: { type: 'string', description: 'The reply. Do not add a signature; Switchboard adds its marker line.' },
        resolve: { type: 'boolean', description: 'Suggest resolving the conversation after the reply. The user decides.' },
      },
      required: ['conversationId', 'text'],
      additionalProperties: false,
    },
    annotations: { title: 'Reply to a review conversation', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async call(args, { signal }) {
      const p = pick(args)
      if ('content' in p) return p
      const draft = checkReplyText(args.text)
      if (!draft.ok) return toolText(draft.message, true)
      const gated = refusePlan(PR_REPLY_TOOL)
      if (gated) return gated
      const conversation = await conversationOf(p, args.conversationId)
      if ('content' in conversation) return conversation
      const suggestResolve = args.resolve === true && !conversation.resolved
      const outcome = await ask(PR_REPLY_TOOL, card(p.ref, 'reply', {
        url: conversation.comments[0]?.url ?? null,
        location: location(conversation),
        quote: quoteOf(conversation),
        replyText: draft.text,
        suggestResolve,
      }), signal)
      if ('content' in outcome) return outcome
      if (outcome.decision === 'deny') return declined(outcome)

      const final = outcome.response.text === undefined ? draft : checkReplyText(outcome.response.text)
      if (!final.ok) return toolText(`The edited reply was refused: ${final.message} Nothing was posted.`, true)
      const resolve = !conversation.resolved && (outcome.response.resolve ?? suggestResolve)
      const posted = await p.access.reply(p.ref, { conversationId: conversation.id, body: withViaMarker(final.text) })
      if (!posted.ok) return toolText(`Posting failed: ${posted.error.message} Nothing was posted.`, true)
      log.info('agent reply posted', { host: p.ref.host, number: p.ref.number, resolve })

      const edited = final.text !== draft.text ? ` The user edited your reply first; what was posted:\n${final.text}` : ''
      if (!resolve) return toolText(`Posted the reply on ${prLabel(p.ref)}${location(conversation) ? ` at ${location(conversation)}` : ''}. The conversation stays open.${edited}`)
      const resolved = await p.access.setResolved(p.ref, { conversationId: conversation.id }, true)
      if (!resolved.ok) {
        return toolText(`Posted the reply, but resolving the conversation failed: ${resolved.error.message} Do not post the reply again.${edited}`, true)
      }
      return toolText(`Posted the reply on ${prLabel(p.ref)} and resolved the conversation.${edited}`)
    },
  }

  const resolveTool: McpTool = {
    name: PR_RESOLVE_TOOL,
    description: [
      'Resolve a review conversation on a pull request linked to this chat, without replying.',
      `Prefer ${PR_REPLY_TOOL} with resolve: true, so the reviewer reads what changed. The user approves it in a`,
      'Switchboard card first. Refused in plan mode.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { pr: PR_ARG, conversationId: { type: 'string', description: `The conversation id from ${PR_CONVERSATIONS_TOOL}.` } },
      required: ['conversationId'],
      additionalProperties: false,
    },
    annotations: { title: 'Resolve a review conversation', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async call(args, { signal }) {
      const p = pick(args)
      if ('content' in p) return p
      const gated = refusePlan(PR_RESOLVE_TOOL)
      if (gated) return gated
      const conversation = await conversationOf(p, args.conversationId)
      if ('content' in conversation) return conversation
      if (conversation.resolved) return toolText('That conversation is already resolved. Nothing to do.')
      const outcome = await ask(PR_RESOLVE_TOOL, card(p.ref, 'resolve', {
        url: conversation.comments[0]?.url ?? null,
        location: location(conversation),
        quote: quoteOf(conversation),
      }), signal)
      if ('content' in outcome) return outcome
      if (outcome.decision === 'deny') return declined(outcome)
      const done = await p.access.setResolved(p.ref, { conversationId: conversation.id }, true)
      if (!done.ok) return toolText(`Resolving failed: ${done.error.message}`, true)
      return toolText(`Resolved the conversation${location(conversation) ? ` at ${location(conversation)}` : ''} on ${prLabel(p.ref)}.`)
    },
  }

  const rerunTool: McpTool = {
    name: PR_RERUN_TOOL,
    description: [
      'Re-run a failed check on a pull request linked to this chat (GitHub Actions only; Bitbucket cannot).',
      `Take checkId from ${PR_STATUS_TOOL}, where canRerun says which checks qualify. The user approves it in a`,
      'Switchboard card first. Refused in plan mode.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: { pr: PR_ARG, checkId: { type: 'string', description: `The check id from ${PR_STATUS_TOOL}.` } },
      required: ['checkId'],
      additionalProperties: false,
    },
    annotations: { title: 'Re-run a failed check', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async call(args, { signal }) {
      const p = pick(args)
      if ('content' in p) return p
      const caps = HOST_CAPABILITIES[p.ref.host]
      if (!caps.rerunChecks) return toolText(caps.rerunUnavailable ?? 'This host cannot re-run checks.', true)
      if (typeof args.checkId !== 'string' || !args.checkId.trim()) return toolText(`No checkId given. Call ${PR_STATUS_TOOL} for the ids.`, true)
      const gated = refusePlan(PR_RERUN_TOOL)
      if (gated) return gated
      const read = await p.access.detail(p.ref)
      if (!read.ok) return toolText(read.error.message, true)
      const check = read.data.checkList.find((c) => c.id === (args.checkId as string).trim())
      if (!check) return toolText(`No check ${args.checkId} on the head commit. Call ${PR_STATUS_TOOL} for the current ids.`, true)
      if (check.state !== 'failure') return toolText(`${check.name} is ${check.state}, not failed. Only a failed check is re-run.`, true)
      if (!check.rerunId) return toolText(`${check.name} is not a GitHub Actions run; it is re-run where it ran.`, true)
      const outcome = await ask(PR_RERUN_TOOL, card(p.ref, 'rerun', { url: check.url, checkName: check.name }), signal)
      if ('content' in outcome) return outcome
      if (outcome.decision === 'deny') return declined(outcome)
      const done = await p.access.rerunCheck(p.ref, { checkId: check.id })
      if (!done.ok) return toolText(`Re-running failed: ${done.error.message}`, true)
      return toolText(`Re-running ${check.name} on ${prLabel(p.ref)}. Check back with ${PR_STATUS_TOOL} later.`)
    },
  }

  return [statusTool, conversationsTool, replyTool, resolveTool, rerunTool]
}

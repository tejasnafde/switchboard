/**
 * The pull request tools of the Switchboard MCP server: three reads that run
 * without asking and five writes that each open one Switchboard approval
 * card. Merging is deliberately absent, and so is a verdict: `draft_review`
 * hands the user a draft, and the user picks Comment, Request changes or
 * Approve in the card.
 *
 * Every tool works only on pull requests linked to the calling chat, and
 * every refusal is tool output with `isError`, never a throw, so the model
 * reads the reason instead of retrying a transport failure.
 */
import {
  AGENT_REPLY_MAX_CHARS,
  AGENT_REVIEW_MAX_BYTES,
  AGENT_REVIEW_MAX_COMMENTS,
  checkReplyText,
  hostWriteDetail,
  hostWriteGate,
  withViaMarker,
  type HostWriteCard,
  type HostWriteReview,
} from '@shared/agent-host-writes'
import {
  checkCommentText,
  checkLineTarget,
  checkReviewDraft,
  diffExcerpt,
  lineLocation,
  reviewFromResponse,
  type DraftLineComment,
} from '@shared/agent-pr-review'
import { findPullRequestUrls, normalizePrRef } from '@shared/pull-request-links'
import {
  lineInDiff,
  REVIEW_EVENT_LABEL,
  reviewEventsFor,
  type InlineCommentInput,
  type PrWriteDone,
  type SubmitReviewInput,
} from '@shared/pull-request-writes'
import {
  HOST_CAPABILITIES,
  PR_HOST_LABEL,
  prKey,
  type PrChangedFile,
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
import { diffPage } from './pr-diff-page'

const log = createMainLogger('mcp:pr-tools')

export const PR_STATUS_TOOL = 'get_pr_status'
export const PR_CONVERSATIONS_TOOL = 'list_pr_conversations'
export const PR_REPLY_TOOL = 'reply_to_conversation'
export const PR_RESOLVE_TOOL = 'resolve_conversation'
export const PR_RERUN_TOOL = 'rerun_check'
export const PR_DIFF_TOOL = 'get_pr_diff'
export const PR_COMMENT_TOOL = 'comment_on_line'
export const PR_REVIEW_TOOL = 'draft_review'

/** What the tools need from Reviews. `PullRequestService` satisfies the reads and writes. */
export interface AgentPullRequestAccess {
  /** PRs linked to the chat (root conversation), oldest link first. */
  linkedPrs(chatId: string): PrRef[]
  detail(ref: PrRef): Promise<PrResult<PrDetail>>
  conversations(ref: PrRef): Promise<PrResult<PrConversation[]>>
  files(ref: PrRef): Promise<PrResult<PrChangedFile[]>>
  reply(ref: PrRef, input: { conversationId: string; body: string }): Promise<PrResult<PrWriteDone>>
  setResolved(ref: PrRef, input: { conversationId: string }, resolved: boolean): Promise<PrResult<PrWriteDone>>
  rerunCheck(ref: PrRef, input: { checkId: string }): Promise<PrResult<PrWriteDone>>
  inlineComment(ref: PrRef, input: InlineCommentInput): Promise<PrResult<PrWriteDone>>
  submitReview(ref: PrRef, input: SubmitReviewInput): Promise<PrResult<PrWriteDone>>
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
/** Diff lines either side of the target: more for one comment, fewer per comment in a review. */
const COMMENT_EXCERPT_RADIUS = 3
const REVIEW_EXCERPT_RADIUS = 1
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
    if (outcome.reason === 'cancelled') return toolText('The call was cancelled before anything was posted.', true)
    return toolText('The user declined. Nothing was posted. Ask them what they want instead of retrying.', true)
  }

  /**
   * Checked last, right before the write: while the card was open the agent
   * may have stopped waiting (it would never hear the write happened and could
   * ask again), and the user may have unlinked the PR or switched to plan mode.
   */
  const afterApproval = (ref: PrRef, toolName: string, signal: AbortSignal): McpToolResult | null => {
    if (signal.aborted) return declined({ decision: 'deny', reason: 'cancelled' })
    const plan = refusePlan(toolName)
    if (plan) return plan
    const key = prKey(normalizePrRef(ref))
    if (!ctx.pullRequests?.linkedPrs(ctx.chatId).some((r) => prKey(normalizePrRef(r)) === key)) {
      return toolText(`${prLabel(ref)} was unlinked from this chat while the card was open. Nothing was posted.`, true)
    }
    return null
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
      `Merging is the user's, not yours; no tool does it. The review verdict is the user's too: ${PR_REVIEW_TOOL} only drafts.`,
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
      const changed = afterApproval(p.ref, PR_REPLY_TOOL, signal)
      if (changed) return changed

      const final = outcome.response.text === undefined ? draft : checkReplyText(outcome.response.text)
      if (!final.ok) return toolText(`The edited reply was refused: ${final.message} Nothing was posted.`, true)
      const resolve = !conversation.resolved && (outcome.response.resolve ?? suggestResolve)
      const posted = await p.access.reply(p.ref, { conversationId: conversation.id, body: withViaMarker(final.text) })
      if (!posted.ok) return toolText(`Posting failed: ${posted.error.message} Nothing was posted.`, true)
      log.info('agent reply posted', { host: p.ref.host, number: p.ref.number, resolve })

      const edited = final.text !== draft.text ? ` The user edited your reply first; what was posted:\n${final.text}` : ''
      if (!resolve) return toolText(`Posted the reply on ${prLabel(p.ref)}${location(conversation) ? ` at ${location(conversation)}` : ''}. The conversation stays open.${edited}`)
      // The post can take a while: check the link and the mode again before the second write.
      if (afterApproval(p.ref, PR_REPLY_TOOL, signal)) {
        return toolText(`Posted the reply on ${prLabel(p.ref)}, but did not resolve the conversation: the chat's link or mode changed while the reply was posting. Do not post the reply again.${edited}`, true)
      }
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
      const changed = afterApproval(p.ref, PR_RESOLVE_TOOL, signal)
      if (changed) return changed
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
      const changed = afterApproval(p.ref, PR_RERUN_TOOL, signal)
      if (changed) return changed
      const done = await p.access.rerunCheck(p.ref, { checkId: check.id })
      if (!done.ok) return toolText(`Re-running failed: ${done.error.message}`, true)
      return toolText(`Re-running ${check.name} on ${prLabel(p.ref)}. Check back with ${PR_STATUS_TOOL} later.`)
    },
  }

  const diffTool: McpTool = {
    name: PR_DIFF_TOOL,
    description: [
      'The changed files of a pull request linked to this chat, with their hunks and the old and new line numbers of',
      `every diff line. Read it before ${PR_COMMENT_TOOL} or ${PR_REVIEW_TOOL}: a comment can only land on a line shown here.`,
      'Long diffs come in pages of about 60 KiB; the end of each page says what it left out and which page to ask for next.',
      '"path" narrows it to one file or a directory. Read-only; runs without asking.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: PR_ARG,
        path: { type: 'string', description: 'Only this file, or every file under this directory.' },
        page: { type: 'integer', minimum: 1, description: 'The page to read, from 1. The previous page says which comes next.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Pull request diff', readOnlyHint: true, openWorldHint: true },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      if (args.path !== undefined && typeof args.path !== 'string') return toolText('"path" is a file or directory path of the diff.', true)
      const page = typeof args.page === 'string' && /^\d{1,6}$/.test(args.page) ? Number(args.page) : args.page
      if (page !== undefined && typeof page !== 'number') return toolText('"page" is a page number, from 1.', true)
      const read = await p.access.files(p.ref)
      if (!read.ok) return toolText(read.error.message, true)
      const heading = `Diff of ${PR_HOST_LABEL[p.ref.host]} ${p.ref.owner}/${p.ref.name} #${p.ref.number}.`
      const out = diffPage(read.data, { heading, path: args.path as string | undefined, page })
      return out.ok ? toolText(out.text) : toolText(out.message, true)
    },
  }

  const TARGET_PROPS = {
    path: { type: 'string', description: `The file path as ${PR_DIFF_TOOL} shows it.` },
    line: { type: 'integer', minimum: 1, description: `The line number from ${PR_DIFF_TOOL}: the new line number for side "new", the old one for side "old".` },
    side: { type: 'string', enum: ['new', 'old'], description: '"new" (default) for an added or unchanged line, "old" for a deleted line.' },
  }

  const notInDiff = (files: PrChangedFile[], targets: DraftLineComment[]): string[] =>
    targets.filter((t) => !lineInDiff(files, t)).map(lineLocation)

  const commentTool: McpTool = {
    name: PR_COMMENT_TOOL,
    description: [
      'Start a new inline comment on one line of a pull request linked to this chat.',
      `Read the diff with ${PR_DIFF_TOOL} first: the line must be one the diff shows, on that side.`,
      `For more than one comment, prefer ONE ${PR_REVIEW_TOOL} over several of these, so the user answers one card, not many.`,
      `To answer an existing thread, use ${PR_REPLY_TOOL} instead.`,
      'The user sees the comment in a Switchboard approval card, can edit it, and decides whether it is posted.',
      `It is posted as the user, ending with a "via Switchboard" line. At most ${AGENT_REPLY_MAX_CHARS} characters. Refused in plan mode.`,
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: PR_ARG,
        ...TARGET_PROPS,
        text: { type: 'string', description: 'The comment. Do not add a signature; Switchboard adds its marker line.' },
      },
      required: ['path', 'line', 'text'],
      additionalProperties: false,
    },
    annotations: { title: 'Comment on a line', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async call(args, { signal }) {
      const p = pick(args)
      if ('content' in p) return p
      const target = checkLineTarget(args)
      if (!target.ok) return toolText(target.message, true)
      const draft = checkCommentText(args.text)
      if (!draft.ok) return toolText(draft.message, true)
      const gated = refusePlan(PR_COMMENT_TOOL)
      if (gated) return gated
      const files = await p.access.files(p.ref)
      if (!files.ok) return toolText(files.error.message, true)
      const where = lineLocation(target.value)
      if (!lineInDiff(files.data, target.value)) {
        return toolText(`${where} is not a line the diff shows on the ${target.value.side} side. Call ${PR_DIFF_TOOL} and pick a line from it. Nothing was sent.`, true)
      }
      const outcome = await ask(PR_COMMENT_TOOL, card(p.ref, 'comment', {
        location: where,
        replyText: draft.value,
        excerpt: diffExcerpt(files.data, target.value, COMMENT_EXCERPT_RADIUS),
      }), signal)
      if ('content' in outcome) return outcome
      if (outcome.decision === 'deny') return declined(outcome)
      const changed = afterApproval(p.ref, PR_COMMENT_TOOL, signal)
      if (changed) return changed

      const final = outcome.response.text === undefined ? draft : checkCommentText(outcome.response.text)
      if (!final.ok) return toolText(`The edited comment was refused: ${final.message} Nothing was posted.`, true)
      const posted = await p.access.inlineComment(p.ref, { ...target.value, body: withViaMarker(final.value) })
      if (!posted.ok) return toolText(`Posting failed: ${posted.error.message} Nothing was posted.`, true)
      log.info('agent line comment posted', { host: p.ref.host, number: p.ref.number })
      const edited = final.value !== draft.value ? ` The user edited your comment first; what was posted:\n${final.value}` : ''
      return toolText(`Posted the comment at ${where} on ${prLabel(p.ref)}.${edited}`)
    },
  }

  const reviewTool: McpTool = {
    name: PR_REVIEW_TOOL,
    description: [
      'Draft a review of a pull request linked to this chat: a summary plus inline comments on lines of the diff.',
      `Read the diff with ${PR_DIFF_TOOL} first; every comment must be on a line it shows, on that side.`,
      `Prefer ONE draft_review with all your comments over several ${PR_COMMENT_TOOL} calls.`,
      'The user reviews the draft in a Switchboard card, edits or removes any comment and the summary, and picks the verdict',
      'themselves: Comment, Request changes or Approve (Approve and Request changes only on a pull request they did not write).',
      'You cannot pick or suggest a verdict, and there is no argument for one. Nothing is posted if the user denies.',
      `Everything is posted as the user, each comment and the summary ending with a "via Switchboard" line.`,
      `At most ${AGENT_REVIEW_MAX_COMMENTS} comments, ${AGENT_REPLY_MAX_CHARS} characters each, ${AGENT_REVIEW_MAX_BYTES / 1024} KiB in all. Refused in plan mode.`,
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: PR_ARG,
        summary: { type: 'string', description: 'The review summary: what the change does well, what must change, and why.' },
        comments: {
          type: 'array',
          maxItems: AGENT_REVIEW_MAX_COMMENTS,
          description: 'Inline comments, one per line. May be empty.',
          items: {
            type: 'object',
            properties: { ...TARGET_PROPS, text: { type: 'string', description: 'The comment. No signature.' } },
            required: ['path', 'line', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'comments'],
      additionalProperties: false,
    },
    annotations: { title: 'Draft a review', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async call(args, { signal }) {
      const p = pick(args)
      if ('content' in p) return p
      const draft = checkReviewDraft(args)
      if (!draft.ok) return toolText(draft.message, true)
      const gated = refusePlan(PR_REVIEW_TOOL)
      if (gated) return gated
      const { summary, comments } = draft.value
      const [detail, files] = await Promise.all([
        p.access.detail(p.ref),
        comments.length > 0 ? p.access.files(p.ref) : Promise.resolve({ ok: true as const, data: [] }),
      ])
      if (!detail.ok) return toolText(detail.error.message, true)
      if (!files.ok) return toolText(files.error.message, true)
      const missing = notInDiff(files.data, comments)
      if (missing.length > 0) {
        return toolText(`Not lines the diff shows: ${missing.join(', ')}. Call ${PR_DIFF_TOOL}, fix their line and side, and send the whole draft again. Nothing was sent.`, true)
      }
      // Both hosts refuse a verdict from the author, and on a PR that is not open.
      const commentOnly = detail.data.viewer.isAuthor ? 'author' : detail.data.state !== 'open' ? 'closed' : undefined
      const review: HostWriteReview = {
        summary,
        comments: comments.map((c, i) => ({ id: `c${i + 1}`, ...c, excerpt: diffExcerpt(files.data, c, REVIEW_EXCERPT_RADIUS) })),
        verdicts: commentOnly ? ['comment'] : reviewEventsFor(detail.data.viewer),
        ...(commentOnly ? { commentOnly } : {}),
      }
      const outcome = await ask(PR_REVIEW_TOOL, card(p.ref, 'review', { url: detail.data.url, review }), signal)
      if ('content' in outcome) return outcome
      if (outcome.decision === 'deny') return declined(outcome)
      const changed = afterApproval(p.ref, PR_REVIEW_TOOL, signal)
      if (changed) return changed

      const final = reviewFromResponse(p.ref.host, review, outcome.response)
      if (!final.ok) return toolText(final.message, true)
      const { verdict } = final.value
      const submitted = await p.access.submitReview(p.ref, {
        event: verdict,
        body: withViaMarker(final.value.summary),
        comments: final.value.comments.map((c) => ({ path: c.path, side: c.side, line: c.line, body: withViaMarker(c.text) })),
      })
      if (!submitted.ok) {
        const posted = submitted.error.postedComments ?? 0
        return toolText(posted > 0
          ? `Submitting the review failed part way: ${submitted.error.message} ${posted} of its comments were posted. Do not submit it again; tell the user.`
          : `Submitting the review failed: ${submitted.error.message} Nothing was posted.`, true)
      }
      log.info('agent review submitted', { host: p.ref.host, number: p.ref.number, verdict, comments: final.value.comments.length })
      const notes = [
        final.value.removed > 0 ? `removed ${final.value.removed} of your comments` : '',
        final.value.edited > 0 ? `edited ${final.value.edited}` : '',
        final.value.summary !== summary ? 'edited the summary' : '',
      ].filter(Boolean)
      return toolText(
        `The user submitted the review on ${prLabel(p.ref)} as ${REVIEW_EVENT_LABEL[verdict]}, with ${final.value.comments.length} inline comments.` +
        `${notes.length > 0 ? ` They ${notes.join(', ')} first.` : ''} Do not post these comments again.`,
      )
    },
  }

  return [statusTool, conversationsTool, diffTool, replyTool, resolveTool, rerunTool, commentTool, reviewTool]
}

/**
 * The pull request tools of the Switchboard MCP server: three reads that run
 * without asking and six writes that each open one Switchboard approval
 * card. Merging is deliberately absent, and so is a verdict: `draft_review`
 * hands the user a draft, and the user picks Comment, Request changes or
 * Approve in the card.
 *
 * Every tool works only on pull requests linked to the calling chat, except
 * `create_pull_request`, which opens one on the repository of the chat's
 * project and links it. Every refusal is tool output with `isError`, never a
 * throw, so the model reads the reason instead of retrying a transport failure.
 */
import {
  AGENT_COMMENT_MAX_LINES,
  AGENT_REPLY_MAX_CHARS,
  AGENT_REVIEW_MAX_BYTES,
  AGENT_REVIEW_MAX_COMMENTS,
  checkReplyText,
  hostWriteDetail,
  createPullRequestGate,
  hostWriteGate,
  withViaMarker,
  type HostWriteCard,
  type HostWriteReview,
} from '@shared/agent-host-writes'
import {
  checkCreatePrArgs,
  checkPrDescription,
  checkPrTitle,
  draftProblem,
  isUncertainCreateFailure,
  PR_DESCRIPTION_MAX_CHARS,
  repositoryProblem,
  type CreatedPr,
  type OpenedPr,
} from '@shared/agent-pr-create'
import {
  AGENT_PR_MAX_REVIEWERS,
  keptReviewers,
  resolveReviewers,
  reviewerLabel,
  type HostWriteReviewer,
  type ReviewerViewer,
} from '@shared/agent-pr-reviewers'
import {
  checkCommentText,
  checkLineTarget,
  checkReviewDraft,
  diffExcerpt,
  reviewFromResponse,
  type DraftLineComment,
} from '@shared/agent-pr-review'
import { findPullRequestUrls, normalizePrRef } from '@shared/pull-request-links'
import {
  lineLocation,
  lineTargetFit,
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
  repoKey,
  type PrChangedFile,
  type PrConversation,
  type PrDetail,
  type PrRef,
  type PrResult,
  type PrReviewerCandidate,
  type RepoRef,
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
export const PR_CREATE_TOOL = 'create_pull_request'

export type RemoteBranchCheck = { ok: true; found: boolean; remote: string } | { ok: false; message: string }

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

  /** The chat's project path (root conversation), or null when it has no Switchboard record. */
  chatProject(chatId: string): string | null
  /** The repository a project's git remotes point at. */
  repoFor(projectPath: string): Promise<RepoRef | null>
  /** The branch checked out in `cwd`, or null. */
  currentBranch(cwd: string): Promise<string | null>
  /** Whether `branch` is on the checkout's remote for `repo` (git ls-remote). */
  remoteHasBranch(cwd: string, repo: RepoRef, branch: string): Promise<RemoteBranchCheck>
  defaultBranch(repo: RepoRef): Promise<PrResult<string>>
  openPullRequestFor(repo: RepoRef, branch: string): Promise<PrResult<CreatedPr | null>>
  /** Returns the open one instead (`existing`) when one appeared for the branch meanwhile. */
  createPullRequest(repo: RepoRef, input: { title: string; description: string; sourceBranch: string; targetBranch: string; draft: boolean; reviewers?: string[] }): Promise<PrResult<OpenedPr & { existing: boolean }>>
  /** Who may review a pull request opened on `repo` (the Reviewers card's candidates), and the signed-in user. */
  reviewerPool(repo: RepoRef): Promise<PrResult<{ candidates: PrReviewerCandidate[]; viewer: ReviewerViewer }>>
  /** Links a PR of the chat's repository to the chat and tells clients; `created` asks Reviews to refresh. */
  /** False when the link could not be stored; the PR exists either way. */
  linkToChat(chatId: string, ref: PrRef, created: boolean): boolean
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
  /** The session's working directory (a worktree for a worktree chat), or null when unknown. */
  cwd(): string | null
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
  if (c.line === null) return c.path
  return `${c.path}:${c.startLine !== undefined ? `${c.startLine}-` : ''}${c.line}`
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

  /** A write the mode allows without a card: it still counts against the budget. */
  const autoApproved = (): AgentApprovalOutcome | McpToolResult => {
    const budget = ctx.budget.take(ctx.chatId)
    return budget.ok ? { decision: 'approve', response: {} } : toolText(budget.message, true)
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
    target: { repository: `${ref.owner}/${ref.name}`, number: ref.number },
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
    line: {
      type: 'integer',
      minimum: 1,
      description: `The line number from ${PR_DIFF_TOOL}: the new line number for side "new", the old one for side "old". The LAST line when the comment covers a range.`,
    },
    startLine: {
      type: 'integer',
      minimum: 1,
      description: `Optional: the first line of a range ending at "line", on the same side and in the same hunk of ${PR_DIFF_TOOL}. At most ${AGENT_COMMENT_MAX_LINES} lines. Omit for one line.`,
    },
    side: { type: 'string', enum: ['new', 'old'], description: '"new" (default) for added or unchanged lines, "old" for deleted lines. Both ends of a range are on this side.' },
  }

  /** Each target the fresh diff does not take, with why. */
  const notInDiff = (files: PrChangedFile[], targets: DraftLineComment[]): string[] =>
    targets.flatMap((t) => {
      const fit = lineTargetFit(files, t)
      if (fit === 'ok') return []
      return [fit === 'split' ? `${lineLocation(t)} (spans two hunks)` : lineLocation(t)]
    })

  const commentTool: McpTool = {
    name: PR_COMMENT_TOOL,
    description: [
      'Start a new inline comment on one line, or a range of lines, of a pull request linked to this chat.',
      `Read the diff with ${PR_DIFF_TOOL} first: the line must be one the diff shows, on that side.`,
      `For a range, "line" is the last line and "startLine" the first: one side, one hunk, at most ${AGENT_COMMENT_MAX_LINES} lines.`,
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
      const fit = lineTargetFit(files.data, target.value)
      if (fit === 'split') {
        return toolText(`${where} spans two hunks of the diff; a comment covers lines of one hunk. Split it, or pick lines from one hunk of ${PR_DIFF_TOOL}. Nothing was sent.`, true)
      }
      if (fit === 'missing') {
        return toolText(`${where} is not a line the diff shows on the ${target.value.side} side. Call ${PR_DIFF_TOOL} and pick a line from it. Nothing was sent.`, true)
      }
      const { startLine, line } = target.value
      const outcome = await ask(PR_COMMENT_TOOL, card(p.ref, 'comment', {
        location: where,
        replyText: draft.value,
        excerpt: diffExcerpt(files.data, target.value, COMMENT_EXCERPT_RADIUS),
        ...(startLine !== undefined ? { lineRange: { start: startLine, end: line } } : {}),
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
      'A comment may cover a range: "line" is its last line and "startLine" its first, on one side and in one hunk.',
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
          description: 'Inline comments, each on one line or a range of lines. May be empty.',
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
        return toolText(`Not lines the diff shows in one hunk: ${missing.join(', ')}. Call ${PR_DIFF_TOOL}, fix their lines and side, and send the whole draft again. Nothing was sent.`, true)
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
        comments: final.value.comments.map((c) => ({
          path: c.path,
          side: c.side,
          line: c.line,
          ...(c.startLine !== undefined ? { startLine: c.startLine } : {}),
          body: withViaMarker(c.text),
        })),
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

  /** The chat's repository, from its project's remotes, or why there is none. */
  const chatRepo = async (access: AgentPullRequestAccess): Promise<{ projectPath: string; repo: RepoRef } | McpToolResult> => {
    const projectPath = access.chatProject(ctx.chatId)
    if (!projectPath) return toolText('This chat has no Switchboard project record, so there is no repository to open a pull request on.', true)
    const repo = await access.repoFor(projectPath)
    if (!repo) return toolText(`The git remotes of ${projectPath} point at neither GitHub nor Bitbucket, so Switchboard cannot open a pull request for it.`, true)
    return { projectPath, repo }
  }

  const linkCreated = (access: AgentPullRequestAccess, repo: RepoRef, pr: CreatedPr, created: boolean): { ref: PrRef; linked: string } => {
    const ref: PrRef = { ...repo, number: pr.number }
    const ok = access.linkToChat(ctx.chatId, ref, created)
    return {
      ref,
      // The PR tools act only on linked PRs, so they are offered only when the link held.
      linked: ok
        ? 'It is linked to this chat and shows in Reviews, and the pull request tools can act on it now.'
        : 'Linking it to this chat failed, so the pull request tools cannot act on it yet: ask the user to use Link to chat in Reviews.',
    }
  }

  const createTool: McpTool = {
    name: PR_CREATE_TOOL,
    description: [
      'Open a pull request on the repository of this chat\'s project (GitHub or Bitbucket), with the user\'s account in Switchboard.',
      'Use this whenever the user asks you to raise, open or create a pull request, instead of gh pr create, bbpr or a host API:',
      'it is the path that is set up with write access, and the pull request is linked to this chat so it shows in Reviews.',
      'Commit and push the branch first (git push -u <remote> <branch>); the source branch must already be on the remote.',
      'sourceBranch defaults to the branch checked out in this chat, targetBranch to the repository\'s default branch.',
      'If a pull request is already open for the source branch, nothing is created: that one is linked to this chat and returned.',
      'The user sees the title, description and reviewers in a Switchboard approval card, can edit them, and decides whether it is opened (in full access it opens without a card).',
      'It is opened as the user, the description ending with a "via Switchboard" line. "draft" is GitHub only. Refused in plan mode.',
      `To ask people to review it, pass "reviewers": up to ${AGENT_PR_MAX_REVIEWERS} logins, display names or emails, each matching exactly one person`,
      'who can review on that repository (GitHub collaborators or a team as team:<slug>, Bitbucket workspace members); case does not matter.',
      'A name that matches nobody or several people is refused before anything is opened, with the close matches listed: call again with one of those logins.',
      'The user sees the reviewers in the card and may remove any. Never name the user: the author cannot review their own pull request.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The pull request title: what the change does, in one line.' },
        description: { type: 'string', description: `What changed and why, how it was tested. Markdown. At most ${PR_DESCRIPTION_MAX_CHARS} characters. No signature; Switchboard adds its marker line.` },
        sourceBranch: { type: 'string', description: 'The branch to merge from, already pushed. Default: the branch checked out in this chat.' },
        targetBranch: { type: 'string', description: 'The branch to merge into. Default: the repository\'s default branch.' },
        draft: { type: 'boolean', description: 'Open it as a draft. GitHub only; refused on Bitbucket.' },
        repository: { type: 'string', description: 'Optional: "owner/name" or its URL. Must be the repository of this chat\'s project; any other is refused.' },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          maxItems: AGENT_PR_MAX_REVIEWERS,
          description: 'Optional: who to ask for a review, by login, display name or email (GitHub teams as team:<slug>). Each must match exactly one person.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Open a pull request', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async call(args, { signal }) {
      const access = ctx.pullRequests
      if (!access) return toolText('Reviews is not available on this backend, so a pull request cannot be opened here.', true)
      const input = checkCreatePrArgs(args)
      if (!input.ok) return toolText(`${input.message} Nothing was created.`, true)
      const gated = refusePlan(PR_CREATE_TOOL)
      if (gated) return gated
      const chat = await chatRepo(access)
      if ('content' in chat) return chat
      const { repo } = chat
      const repoLabel = `${repo.owner}/${repo.name}`
      const refused = repositoryProblem(input.value.repository, repo) ?? draftProblem(repo.host, input.value.draft)
      if (refused) return toolText(refused, true)

      const cwd = ctx.cwd() ?? chat.projectPath
      const source = input.value.sourceBranch ?? await access.currentBranch(cwd)
      if (!source) return toolText(`No branch is checked out in ${cwd} (a detached HEAD?). Pass "sourceBranch". Nothing was created.`, true)
      let target = input.value.targetBranch
      if (!target) {
        const read = await access.defaultBranch(repo)
        if (!read.ok) return toolText(`Could not read the default branch of ${repoLabel}: ${read.error.message} Pass "targetBranch", or tell the user.`, true)
        target = read.data
      }
      if (source === target) {
        return toolText(`The source and target branch are both ${source}. Commit to a new branch, push it, and call again with that branch. Nothing was created.`, true)
      }
      const pushed = await access.remoteHasBranch(cwd, repo, source)
      if (!pushed.ok) return toolText(`${pushed.message} Could not check that ${source} is pushed. Nothing was created.`, true)
      if (!pushed.found) {
        return toolText(`${source} is not on ${pushed.remote} (${repoLabel}). Push it first (git push -u ${pushed.remote} ${source}), then call again. Nothing was created.`, true)
      }
      const open = await access.openPullRequestFor(repo, source)
      if (!open.ok) return toolText(`Could not check for an open pull request on ${repoLabel}: ${open.error.message} Nothing was created.`, true)
      if (open.data) {
        const { linked } = linkCreated(access, repo, open.data, false)
        const skipped = input.value.reviewers.length > 0 ? ' Its reviewers were not changed; the user can add them in Reviews.' : ''
        return toolText(`A pull request is already open for ${source}: ${repoLabel} #${open.data.number}, ${open.data.url}. ${linked} No new one was created.${skipped}`)
      }

      let reviewers: HostWriteReviewer[] = []
      if (input.value.reviewers.length > 0) {
        const pool = await access.reviewerPool(repo)
        if (!pool.ok) {
          return toolText(`Could not read who can review on ${repoLabel}: ${pool.error.message} Call again without "reviewers", or tell the user. Nothing was created.`, true)
        }
        const resolved = resolveReviewers(repo.host, input.value.reviewers, pool.data.candidates, pool.data.viewer)
        if (!resolved.ok) return toolText(resolved.message, true)
        reviewers = resolved.value
      }

      const draft = { title: input.value.title, description: input.value.description }
      const withoutCard = createPullRequestGate(ctx.runtimeMode()) === 'allow'
      const outcome = withoutCard ? autoApproved() : await ask(PR_CREATE_TOOL, {
        action: 'create',
        agentLabel: ctx.agentLabel,
        host: repo.host,
        prLabel: repoLabel,
        target: { repository: `${repo.owner}/${repo.name}`, number: null },
        url: null,
        location: null,
        quote: null,
        create: { repoLabel, sourceBranch: source, targetBranch: target, ...draft, draft: input.value.draft, ...(reviewers.length > 0 ? { reviewers } : {}) },
        maxChars: PR_DESCRIPTION_MAX_CHARS,
      }, signal)
      if ('content' in outcome) return outcome
      if (outcome.decision === 'deny') return declined(outcome)
      if (signal.aborted) return declined({ decision: 'deny', reason: 'cancelled' })
      const plan = refusePlan(PR_CREATE_TOOL)
      if (plan) return plan
      // The link rule again: the project must still point at the repository the card named.
      const now = await access.repoFor(chat.projectPath)
      if (!now || repoKey(now) !== repoKey(repo)) {
        return toolText(`This chat's project no longer points at ${repoLabel}. Nothing was created.`, true)
      }

      const title = outcome.response.title === undefined ? { ok: true as const, value: draft.title } : checkPrTitle(outcome.response.title)
      if (!title.ok) return toolText(`The edited title was refused: ${title.message} Nothing was created.`, true)
      const description = outcome.response.description === undefined ? { ok: true as const, value: draft.description } : checkPrDescription(outcome.response.description)
      if (!description.ok) return toolText(`The edited description was refused: ${description.message} Nothing was created.`, true)
      // No card was shown, so full access must still hold after the awaits above.
      if (withoutCard && createPullRequestGate(ctx.runtimeMode()) !== 'allow') {
        return toolText('The chat left full access before the pull request was opened, so nothing was created. Call again: the user will see an approval card.', true)
      }
      const kept = keptReviewers(reviewers, outcome.response.reviewers)
      const created = await access.createPullRequest(repo, {
        title: title.value,
        description: withViaMarker(description.value),
        sourceBranch: source,
        targetBranch: target,
        draft: input.value.draft,
        ...(kept.length > 0 ? { reviewers: kept.map((r) => r.id) } : {}),
      })
      if (!created.ok) {
        if (!isUncertainCreateFailure(created.error)) return toolText(`Opening the pull request failed: ${created.error.message} Nothing was created.`, true)
        // The request may have gone out: look before telling the agent anything.
        const after = await access.openPullRequestFor(repo, source)
        if (after.ok && after.data) {
          const { linked } = linkCreated(access, repo, after.data, true)
          const unsure = kept.length > 0 ? ' Whether its reviewers were asked is not known: tell the user to check them in Reviews.' : ''
          return toolText(`Opened ${repoLabel} #${after.data.number}: ${after.data.url} (the host's answer was lost, but the pull request is there). ${linked} Do not open it again.${unsure}`)
        }
        log.warn('agent pull request create result uncertain', { host: repo.host, kind: created.error.kind })
        return toolText(
          `The host did not answer clearly: ${created.error.message} The pull request may or may not have been opened. ` +
          `Do not call ${PR_CREATE_TOOL} again; ask the user to check ${PR_HOST_LABEL[repo.host]} or Reviews.`, true)
      }
      const { ref, linked } = linkCreated(access, repo, created.data, !created.data.existing)
      if (created.data.existing) {
        const skipped = kept.length > 0 ? ' Its reviewers were not changed; the user can add them in Reviews.' : ''
        return toolText(`A pull request for ${source} was opened while the card was open: ${repoLabel} #${ref.number}, ${created.data.url}. ${linked} No new one was created.${skipped}`)
      }
      log.info('agent pull request opened', { host: repo.host, number: ref.number, reviewers: kept.length })
      const removed = reviewers.filter((r) => !kept.includes(r))
      const edits = [
        title.value !== draft.title ? `the title to "${title.value}"` : '',
        description.value !== draft.description ? 'the description' : '',
        removed.length > 0 ? `the reviewers, removing ${removed.map(reviewerLabel).join(', ')}` : '',
      ].filter(Boolean)
      const failure = created.data.reviewerFailure
      const asked = kept.length === 0 ? ''
        : failure
          ? ` Asking ${kept.filter((r) => failure.reviewers.includes(r.id)).map(reviewerLabel).join(', ')} to review failed: ${failure.error.message} ` +
            `The pull request is open either way: do not open it again. Tell the user, who can add them in Reviews.`
          : ` Asked ${kept.map(reviewerLabel).join(', ')} to review it.`
      return toolText(
        `Opened ${repoLabel} #${ref.number}: ${created.data.url} (${source} -> ${target}). ${linked}` +
        `${edits.length > 0 ? ` The user edited ${edits.join(' and ')} first.` : ''}${asked}`,
      )
    },
  }

  return [statusTool, conversationsTool, diffTool, createTool, replyTool, resolveTool, rerunTool, commentTool, reviewTool]
}

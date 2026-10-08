/**
 * The pull request tools of the Switchboard MCP server: three reads that run
 * without asking and six writes that each open one Switchboard approval
 * card. Merging is deliberately absent, and so is a verdict: `draft_review`
 * hands the user a draft, and the user picks Comment, Request changes or
 * Approve in the card.
 *
 * A write does not wait for the card: the tool queues it and returns, and the
 * approval runs its stored plan later (`runPrWritePlan`), with the link and
 * mode re-checked then. Every tool works only on pull requests linked to the calling chat, except
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
  type HostWriteResponse,
  type HostWriteReview,
} from '@shared/agent-host-writes'
import { queuedToolText } from '@shared/agent-approval-cards'
import {
  checkCreatePrArgs,
  checkPrDescription,
  checkPrTitle,
  draftProblem,
  isUncertainCreateFailure,
  PR_DESCRIPTION_MAX_CHARS,
  repoArgCandidates,
  repoPathRepositoryProblem,
  repositoryProblem,
  type CreatedPr,
  type CreatePrArgs,
  type OpenedPr,
} from '@shared/agent-pr-create'
import {
  coveredRepos,
  describeChildRepos,
  findChildRepo,
  projectCoversRepo,
  type ProjectRepos,
} from '@shared/project-repos'
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
import { findPullRequestUrls, normalizePrRef, type PrLink } from '@shared/pull-request-links'
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
import type { AgentApprovalBroker } from './agent-approvals'
import type { AgentWriteBudget } from './agent-write-budget'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'
import { diffPage } from './pr-diff-page'
import type { RepoDir } from '../pull-requests/project-repos'

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

/** Where `create_pull_request` opens: the repository, and the work tree whose branch is the source. */
interface CreateTarget {
  projectPath: string
  repo: RepoRef
  cwd: string
  /** The child work tree relative to the project folder, shown in the card; null for the project's own checkout. */
  localPath: string | null
}

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
  /** The repository a directory's git remotes point at. */
  repoFor(dir: string): Promise<RepoRef | null>
  /** The repositories a project covers (`shared/project-repos.ts`); `fresh` skips the cached scan. */
  projectRepos(projectPath: string, opts?: { fresh?: boolean }): Promise<ProjectRepos>
  /** `repoPath` as the real path of a git work tree inside the project folder (`pull-requests/project-repos.ts`). */
  resolveRepoDir(projectPath: string, repoPath: string): Promise<RepoDir>
  /** The branch checked out in `cwd`, or null. */
  currentBranch(cwd: string): Promise<string | null>
  /** Whether `branch` is on the checkout's remote for `repo` (git ls-remote). */
  remoteHasBranch(cwd: string, repo: RepoRef, branch: string): Promise<RemoteBranchCheck>
  defaultBranch(repo: RepoRef): Promise<PrResult<string>>
  openPullRequestFor(repo: RepoRef, branch: string): Promise<PrResult<CreatedPr | null>>
  /** Returns the open one instead (`existing`) when one appeared for the branch meanwhile. */
  createPullRequest(
    repo: RepoRef,
    input: {
      title: string
      description: string
      sourceBranch: string
      targetBranch: string
      draft: boolean
      reviewers?: string[]
    },
  ): Promise<PrResult<OpenedPr & { existing: boolean }>>
  /** Who may review a pull request opened on `repo` (the Reviewers card's candidates), and the signed-in user. */
  reviewerPool(repo: RepoRef): Promise<PrResult<{ candidates: PrReviewerCandidate[]; viewer: ReviewerViewer }>>
  /**
   * Links a PR of the chat's repository to the chat as the agent's and tells
   * clients. `created`: the agent opened it (source `created`, and Reviews
   * refreshes); otherwise source `agent`. False when the link could not be stored.
   */
  linkToChat(chatId: string, ref: PrRef, created: boolean): boolean
  /** The chat's live links, with how each was made and its last known state. */
  links(chatId: string): PrLink[]
  /** Tombstones a link and tells clients; false when it was not linked. */
  unlinkFromChat(chatId: string, ref: PrRef): boolean
  /** The last failure automatic linking hit for the chat (auto-link, history scan, branch detection, state sync). */
  linkProblem(chatId: string): { at: number; message: string } | null
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
  approvals: Pick<AgentApprovalBroker, 'open' | 'openProblem'>
  budget: Pick<AgentWriteBudget, 'take'>
  /** Null on a backend without Reviews. */
  pullRequests: AgentPullRequestAccess | null
}

/** What running an approved write needs: the chat, its mode now, and Reviews. */
export type PrWriteRunContext = Pick<PrToolContext, 'threadId' | 'chatId' | 'runtimeMode' | 'publish' | 'pullRequests'>

/**
 * A pull request write as an approval card stores it: everything the write
 * needs after the card, as data, so the card survives a backend restart.
 */
export type PrWritePlan =
  | {
      kind: 'pr-reply'
      ref: PrRef
      conversationId: string
      conversationResolved: boolean
      location: string | null
      draft: string
      suggestResolve: boolean
    }
  | { kind: 'pr-resolve'; ref: PrRef; conversationId: string; location: string | null }
  | { kind: 'pr-rerun'; ref: PrRef; checkId: string; checkName: string }
  | { kind: 'pr-comment'; ref: PrRef; target: Omit<DraftLineComment, 'text'>; draft: string }
  | { kind: 'pr-review'; ref: PrRef; review: HostWriteReview }
  | {
      kind: 'pr-create'
      repo: RepoRef
      projectPath: string
      source: string
      target: string
      title: string
      description: string
      draft: boolean
      reviewers: HostWriteReviewer[]
    }

export function isPrWritePlan(plan: { kind: string }): plan is PrWritePlan {
  return plan.kind.startsWith('pr-')
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
  'The user links one from Reviews ("Link to chat"), you can link one with link_pull_request, and a pull request of this project ' +
  "links itself once its URL appears in the chat or it is the open pull request of the chat's branch."

/**
 * The linked PR the agent means: `pr` as a number, "#612" or a URL, or omitted
 * when exactly one is linked. Never a PR outside the links.
 */
export function pickLinkedPr(linked: PrRef[], pr: unknown): { ok: true; ref: PrRef } | { ok: false; message: string } {
  if (linked.length === 0) return { ok: false, message: NO_LINK }
  if (pr === undefined || pr === null || pr === '') {
    if (linked.length === 1) return { ok: true, ref: linked[0] }
    return {
      ok: false,
      message: `Several pull requests are linked to this chat (${describeLinks(linked)}). Pass "pr" with the one you mean.`,
    }
  }
  const text = String(pr).trim()
  const url = findPullRequestUrls(text)[0]
  if (url) {
    const hit = linked.find((r) => prKey(normalizePrRef(r)) === prKey(url))
    return hit
      ? { ok: true, ref: hit }
      : { ok: false, message: `${text} is not linked to this chat. Linked: ${describeLinks(linked)}.` }
  }
  const number = /^#?(\d{1,9})$/.exec(text)?.[1]
  if (!number)
    return { ok: false, message: `"${text}" is not a pull request number or URL. Linked: ${describeLinks(linked)}.` }
  const hits = linked.filter((r) => r.number === Number(number))
  if (hits.length === 1) return { ok: true, ref: hits[0] }
  if (hits.length === 0)
    return { ok: false, message: `#${number} is not linked to this chat. Linked: ${describeLinks(linked)}.` }
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
  description:
    'The pull request: its number, "#612" or its URL. Optional when exactly one pull request is linked to this chat.',
}

type Picked = { ref: PrRef; access: AgentPullRequestAccess }

export function buildPrTools(ctx: PrToolContext): McpTool[] {
  const pick = (args: Record<string, unknown>): Picked | McpToolResult => {
    const access = ctx.pullRequests
    if (!access)
      return toolText('Reviews is not available on this backend, so pull request tools cannot run here.', true)
    const picked = pickLinkedPr(access.linkedPrs(ctx.chatId), args.pr)
    return picked.ok ? { ref: picked.ref, access } : toolText(picked.message, true)
  }

  const refusePlan = (toolName: string): McpToolResult | null => refusePlanFor(ctx, toolName)

  const conversationOf = async (p: Picked, id: unknown): Promise<PrConversation | McpToolResult> => {
    if (typeof id !== 'string' || !id.trim())
      return toolText(`No conversationId given. Call ${PR_CONVERSATIONS_TOOL} for the ids.`, true)
    const read = await p.access.conversations(p.ref)
    if (!read.ok) return toolText(read.error.message, true)
    const found = read.data.find((c) => c.id === id.trim())
    return (
      found ??
      toolText(`No conversation ${id} on ${prLabel(p.ref)}. Call ${PR_CONVERSATIONS_TOOL} for the current ids.`, true)
    )
  }

  /**
   * Opens the card and returns at once: the approval runs `plan` later. The
   * cap is checked before the budget is charged, and the budget before the
   * card opens: a write counts once it would interrupt the user.
   */
  const queue = (toolName: string, card: HostWriteCard, plan: PrWritePlan): McpToolResult => {
    const full = ctx.approvals.openProblem(ctx.chatId)
    if (full) return toolText(full, true)
    const budget = ctx.budget.take(ctx.chatId)
    if (!budget.ok) return toolText(budget.message, true)
    const opened = ctx.approvals.open({
      threadId: ctx.threadId,
      chatId: ctx.chatId,
      toolName: `mcp__switchboard__${toolName}`,
      detail: hostWriteDetail(card),
      hostWrite: card,
      plan,
    })
    return opened.ok ? toolText(queuedToolText(opened.requestId)) : toolText(opened.message, true)
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
      return toolText(
        JSON.stringify(
          {
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
          },
          null,
          2,
        ),
      )
    },
  }

  const conversationsTool: McpTool = {
    name: PR_CONVERSATIONS_TOOL,
    description: [
      "The review conversations (inline threads) on a pull request linked to this chat, with each one's id,",
      'file and line, and its comments. Open ones only unless includeResolved is true. Read-only; runs without asking.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: PR_ARG,
        includeResolved: { type: 'boolean', description: 'Also list resolved conversations.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Pull request conversations', readOnlyHint: true, openWorldHint: true },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      const read = await p.access.conversations(p.ref)
      if (!read.ok) return toolText(read.error.message, true)
      const list = read.data.filter((c) => args.includeResolved === true || !c.resolved)
      if (list.length === 0)
        return toolText(`${prLabel(p.ref)} has no ${args.includeResolved === true ? '' : 'open '}review conversations.`)
      return toolText(
        JSON.stringify(
          list.map((c) => ({
            id: c.id,
            location: location(c),
            resolved: c.resolved,
            outdated: c.outdated,
            comments: c.comments.map((m) => ({
              author: m.author.login,
              body: cap(m.body, COMMENT_MAX_CHARS),
              at: new Date(m.createdAt).toISOString(),
            })),
          })),
          null,
          2,
        ),
      )
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
        resolve: {
          type: 'boolean',
          description: 'Suggest resolving the conversation after the reply. The user decides.',
        },
      },
      required: ['conversationId', 'text'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Reply to a review conversation',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      const draft = checkReplyText(args.text)
      if (!draft.ok) return toolText(draft.message, true)
      const gated = refusePlan(PR_REPLY_TOOL)
      if (gated) return gated
      const conversation = await conversationOf(p, args.conversationId)
      if ('content' in conversation) return conversation
      const suggestResolve = args.resolve === true && !conversation.resolved
      return queue(
        PR_REPLY_TOOL,
        card(p.ref, 'reply', {
          url: conversation.comments[0]?.url ?? null,
          location: location(conversation),
          quote: quoteOf(conversation),
          replyText: draft.text,
          suggestResolve,
        }),
        {
          kind: 'pr-reply',
          ref: p.ref,
          conversationId: conversation.id,
          conversationResolved: conversation.resolved,
          location: location(conversation),
          draft: draft.text,
          suggestResolve,
        },
      )
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
      properties: {
        pr: PR_ARG,
        conversationId: { type: 'string', description: `The conversation id from ${PR_CONVERSATIONS_TOOL}.` },
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Resolve a review conversation',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      const gated = refusePlan(PR_RESOLVE_TOOL)
      if (gated) return gated
      const conversation = await conversationOf(p, args.conversationId)
      if ('content' in conversation) return conversation
      if (conversation.resolved) return toolText('That conversation is already resolved. Nothing to do.')
      return queue(
        PR_RESOLVE_TOOL,
        card(p.ref, 'resolve', {
          url: conversation.comments[0]?.url ?? null,
          location: location(conversation),
          quote: quoteOf(conversation),
        }),
        { kind: 'pr-resolve', ref: p.ref, conversationId: conversation.id, location: location(conversation) },
      )
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
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      const caps = HOST_CAPABILITIES[p.ref.host]
      if (!caps.rerunChecks) return toolText(caps.rerunUnavailable ?? 'This host cannot re-run checks.', true)
      if (typeof args.checkId !== 'string' || !args.checkId.trim())
        return toolText(`No checkId given. Call ${PR_STATUS_TOOL} for the ids.`, true)
      const gated = refusePlan(PR_RERUN_TOOL)
      if (gated) return gated
      const read = await p.access.detail(p.ref)
      if (!read.ok) return toolText(read.error.message, true)
      const check = read.data.checkList.find((c) => c.id === (args.checkId as string).trim())
      if (!check)
        return toolText(
          `No check ${args.checkId} on the head commit. Call ${PR_STATUS_TOOL} for the current ids.`,
          true,
        )
      if (check.state !== 'failure')
        return toolText(`${check.name} is ${check.state}, not failed. Only a failed check is re-run.`, true)
      if (!check.rerunId) return toolText(`${check.name} is not a GitHub Actions run; it is re-run where it ran.`, true)
      return queue(PR_RERUN_TOOL, card(p.ref, 'rerun', { url: check.url, checkName: check.name }), {
        kind: 'pr-rerun',
        ref: p.ref,
        checkId: check.id,
        checkName: check.name,
      })
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
        page: {
          type: 'integer',
          minimum: 1,
          description: 'The page to read, from 1. The previous page says which comes next.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Pull request diff', readOnlyHint: true, openWorldHint: true },
    async call(args) {
      const p = pick(args)
      if ('content' in p) return p
      if (args.path !== undefined && typeof args.path !== 'string')
        return toolText('"path" is a file or directory path of the diff.', true)
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
    side: {
      type: 'string',
      enum: ['new', 'old'],
      description:
        '"new" (default) for added or unchanged lines, "old" for deleted lines. Both ends of a range are on this side.',
    },
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
    async call(args) {
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
        return toolText(
          `${where} spans two hunks of the diff; a comment covers lines of one hunk. Split it, or pick lines from one hunk of ${PR_DIFF_TOOL}. Nothing was sent.`,
          true,
        )
      }
      if (fit === 'missing') {
        return toolText(
          `${where} is not a line the diff shows on the ${target.value.side} side. Call ${PR_DIFF_TOOL} and pick a line from it. Nothing was sent.`,
          true,
        )
      }
      const { startLine, line } = target.value
      return queue(
        PR_COMMENT_TOOL,
        card(p.ref, 'comment', {
          location: where,
          replyText: draft.value,
          excerpt: diffExcerpt(files.data, target.value, COMMENT_EXCERPT_RADIUS),
          ...(startLine !== undefined ? { lineRange: { start: startLine, end: line } } : {}),
        }),
        { kind: 'pr-comment', ref: p.ref, target: target.value, draft: draft.value },
      )
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
        summary: {
          type: 'string',
          description: 'The review summary: what the change does well, what must change, and why.',
        },
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
    async call(args) {
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
        return toolText(
          `Not lines the diff shows in one hunk: ${missing.join(', ')}. Call ${PR_DIFF_TOOL}, fix their lines and side, and send the whole draft again. Nothing was sent.`,
          true,
        )
      }
      // Both hosts refuse a verdict from the author, and on a PR that is not open.
      const commentOnly = detail.data.viewer.isAuthor ? 'author' : detail.data.state !== 'open' ? 'closed' : undefined
      const review: HostWriteReview = {
        summary,
        comments: comments.map((c, i) => ({
          id: `c${i + 1}`,
          ...c,
          excerpt: diffExcerpt(files.data, c, REVIEW_EXCERPT_RADIUS),
        })),
        verdicts: commentOnly ? ['comment'] : reviewEventsFor(detail.data.viewer),
        ...(commentOnly ? { commentOnly } : {}),
      }
      return queue(PR_REVIEW_TOOL, card(p.ref, 'review', { url: detail.data.url, review }), {
        kind: 'pr-review',
        ref: p.ref,
        review,
      })
    },
  }

  /**
   * The repository to open on and the work tree whose branch is the source:
   * `repoPath` when given, else the project's own repository and the chat's
   * checkout, else the one child repository of a parent folder that
   * `repository` names. Every path ends at a repository the project covers.
   */
  const createTarget = async (
    access: AgentPullRequestAccess,
    input: CreatePrArgs,
  ): Promise<CreateTarget | McpToolResult> => {
    const projectPath = access.chatProject(ctx.chatId)
    if (!projectPath)
      return toolText(
        'This chat has no Switchboard project record, so there is no repository to open a pull request on.',
        true,
      )
    const project = await access.projectRepos(projectPath)
    if (input.repoPath) {
      const dir = await access.resolveRepoDir(projectPath, input.repoPath)
      if (!dir.ok) return toolText(`${dir.message} Nothing was created.`, true)
      if (project.own) {
        // A project that is a repository covers only its own checkout: a nested
        // clone of the same remote must not become the source branch. The
        // folder itself falls through to the chat's checkout below.
        if (dir.relPath !== '.') {
          return toolText(
            `${projectPath} is itself a repository (${project.own.owner}/${project.own.name}), so "repoPath" can only be the project folder; ` +
              `${dir.relPath} is inside it. Call again without "repoPath". Nothing was created.`,
            true,
          )
        }
      } else {
        const repo = await access.repoFor(dir.dir)
        if (!repo)
          return toolText(
            `The git remotes of ${dir.relPath} (under ${projectPath}) point at neither GitHub nor Bitbucket, so Switchboard cannot open a pull request for it. Nothing was created.`,
            true,
          )
        const refused = repoPathRepositoryProblem(input.repository, repo, dir.relPath)
        if (refused) return toolText(refused, true)
        if (!projectCoversRepo(project, repo)) {
          const covered = coveredRepos(project)
            .map((r) => `${r.owner}/${r.name}`)
            .join(', ')
          return toolText(
            `${dir.relPath} points at ${repo.owner}/${repo.name}, which is not a repository this chat's project covers` +
              `${covered ? ` (it covers ${covered})` : ''}. Nothing was created.`,
            true,
          )
        }
        return { projectPath, repo, cwd: dir.dir, localPath: dir.relPath }
      }
    }
    if (project.own) {
      const refused = repositoryProblem(input.repository, project.own)
      if (refused) return toolText(refused, true)
      return { projectPath, repo: project.own, cwd: ctx.cwd() ?? projectPath, localPath: null }
    }
    if (project.children.length === 0) {
      return toolText(
        `The git remotes of ${projectPath} point at neither GitHub nor Bitbucket, and no GitHub or Bitbucket repository was found up to two folders below it, ` +
          'so Switchboard cannot open a pull request for it.',
        true,
      )
    }
    const listed = describeChildRepos(project.children)
    if (!input.repository) {
      return toolText(
        `${projectPath} is not a repository itself; it holds ${listed}. Call again with "repoPath" naming the one the change is in. Nothing was created.`,
        true,
      )
    }
    const match = findChildRepo(project, repoArgCandidates(input.repository))
    if (match.kind === 'none') {
      return toolText(
        `No repository under ${projectPath} has its remote at "${input.repository}". It holds ${listed}. Nothing was created.`,
        true,
      )
    }
    if (match.kind === 'many') {
      return toolText(
        `Several checkouts under ${projectPath} point at "${input.repository}": ${describeChildRepos(match.matches)}. Call again with "repoPath" naming one. Nothing was created.`,
        true,
      )
    }
    return { projectPath, repo: match.child.repo, cwd: match.child.path, localPath: match.child.relPath }
  }

  const createTool: McpTool = {
    name: PR_CREATE_TOOL,
    description: [
      "Open a pull request on the repository of this chat's project (GitHub or Bitbucket), with the user's account in Switchboard.",
      'Use this whenever the user asks you to raise, open or create a pull request, instead of gh pr create, bbpr or a host API:',
      'it is the path that is set up with write access, and the pull request is linked to this chat so it shows in Reviews.',
      'Commit and push the branch first (git push -u <remote> <branch>); the source branch must already be on the remote.',
      "sourceBranch defaults to the branch checked out in this chat, targetBranch to the repository's default branch.",
      'When the project folder holds several repositories (it is not one itself), pass "repoPath": the repository the change is in,',
      'relative to the project folder or absolute; its git remote is the repository and its checked-out branch the default sourceBranch.',
      '"repository" alone also works there when exactly one repository under the folder has that remote.',
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
        description: {
          type: 'string',
          description: `What changed and why, how it was tested. Markdown. At most ${PR_DESCRIPTION_MAX_CHARS} characters. No signature; Switchboard adds its marker line.`,
        },
        sourceBranch: {
          type: 'string',
          description: 'The branch to merge from, already pushed. Default: the branch checked out in this chat.',
        },
        targetBranch: {
          type: 'string',
          description: "The branch to merge into. Default: the repository's default branch.",
        },
        draft: { type: 'boolean', description: 'Open it as a draft. GitHub only; refused on Bitbucket.' },
        repository: {
          type: 'string',
          description:
            'Optional: "owner/name" or its URL. Must be a repository of this chat\'s project (with repoPath, that path\'s remote); any other is refused.',
        },
        repoPath: {
          type: 'string',
          description:
            "Optional: a git repository inside this chat's project folder, relative to it or absolute, for a project folder that holds several repositories. Anything outside the folder is refused.",
        },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          maxItems: AGENT_PR_MAX_REVIEWERS,
          description:
            'Optional: who to ask for a review, by login, display name or email (GitHub teams as team:<slug>). Each must match exactly one person.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Open a pull request', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async call(args) {
      const access = ctx.pullRequests
      if (!access)
        return toolText('Reviews is not available on this backend, so a pull request cannot be opened here.', true)
      const input = checkCreatePrArgs(args)
      if (!input.ok) return toolText(`${input.message} Nothing was created.`, true)
      const gated = refusePlan(PR_CREATE_TOOL)
      if (gated) return gated
      const chat = await createTarget(access, input.value)
      if ('content' in chat) return chat
      const { repo, cwd } = chat
      const repoLabel = `${repo.owner}/${repo.name}`
      const refused = draftProblem(repo.host, input.value.draft)
      if (refused) return toolText(refused, true)

      const source = input.value.sourceBranch ?? (await access.currentBranch(cwd))
      if (!source)
        return toolText(
          `No branch is checked out in ${cwd} (a detached HEAD?). Pass "sourceBranch". Nothing was created.`,
          true,
        )
      let target = input.value.targetBranch
      if (!target) {
        const read = await access.defaultBranch(repo)
        if (!read.ok)
          return toolText(
            `Could not read the default branch of ${repoLabel}: ${read.error.message} Pass "targetBranch", or tell the user.`,
            true,
          )
        target = read.data
      }
      if (source === target) {
        return toolText(
          `The source and target branch are both ${source}. Commit to a new branch, push it, and call again with that branch. Nothing was created.`,
          true,
        )
      }
      const pushed = await access.remoteHasBranch(cwd, repo, source)
      if (!pushed.ok)
        return toolText(`${pushed.message} Could not check that ${source} is pushed. Nothing was created.`, true)
      if (!pushed.found) {
        return toolText(
          `${source} is not on ${pushed.remote} (${repoLabel}). Push it first (git push -u ${pushed.remote} ${source}), then call again. Nothing was created.`,
          true,
        )
      }
      const open = await access.openPullRequestFor(repo, source)
      if (!open.ok)
        return toolText(
          `Could not check for an open pull request on ${repoLabel}: ${open.error.message} Nothing was created.`,
          true,
        )
      if (open.data) {
        const { linked } = linkCreated(access, ctx.chatId, repo, open.data, false)
        const skipped =
          input.value.reviewers.length > 0 ? ' Its reviewers were not changed; the user can add them in Reviews.' : ''
        return toolText(
          `A pull request is already open for ${source}: ${repoLabel} #${open.data.number}, ${open.data.url}. ${linked} No new one was created.${skipped}`,
        )
      }

      let reviewers: HostWriteReviewer[] = []
      if (input.value.reviewers.length > 0) {
        const pool = await access.reviewerPool(repo)
        if (!pool.ok) {
          return toolText(
            `Could not read who can review on ${repoLabel}: ${pool.error.message} Call again without "reviewers", or tell the user. Nothing was created.`,
            true,
          )
        }
        const resolved = resolveReviewers(repo.host, input.value.reviewers, pool.data.candidates, pool.data.viewer)
        if (!resolved.ok) return toolText(resolved.message, true)
        reviewers = resolved.value
      }

      const plan: PrWritePlan = {
        kind: 'pr-create',
        repo,
        projectPath: chat.projectPath,
        source,
        target,
        title: input.value.title,
        description: input.value.description,
        draft: input.value.draft,
        reviewers,
      }
      // Full access opens it without a card, in this call.
      if (createPullRequestGate(ctx.runtimeMode()) === 'allow') {
        const budget = ctx.budget.take(ctx.chatId)
        if (!budget.ok) return toolText(budget.message, true)
        return runPrWritePlan(ctx, plan, {}, { withoutCard: true })
      }
      return queue(
        PR_CREATE_TOOL,
        {
          action: 'create',
          agentLabel: ctx.agentLabel,
          host: repo.host,
          prLabel: repoLabel,
          target: { repository: `${repo.owner}/${repo.name}`, number: null },
          url: null,
          location: null,
          quote: null,
          create: {
            repoLabel,
            ...(chat.localPath ? { localPath: chat.localPath } : {}),
            sourceBranch: source,
            targetBranch: target,
            title: plan.title,
            description: plan.description,
            draft: input.value.draft,
            ...(reviewers.length > 0 ? { reviewers } : {}),
          },
          maxChars: PR_DESCRIPTION_MAX_CHARS,
        },
        plan,
      )
    },
  }

  return [
    statusTool,
    conversationsTool,
    diffTool,
    createTool,
    replyTool,
    resolveTool,
    rerunTool,
    commentTool,
    reviewTool,
  ]
}

type PlanGateContext = Pick<PrToolContext, 'threadId' | 'runtimeMode' | 'publish'>

/** Plan mode refuses a write: before anything is read, and again after the card. */
function refusePlanFor(ctx: PlanGateContext, toolName: string): McpToolResult | null {
  const mode = ctx.runtimeMode()
  if (hostWriteGate(mode) !== 'deny') return null
  const reason =
    'Plan mode - nothing is posted to a pull request. Tell the user what you would post, or ask them to switch modes.'
  ctx.publish({ type: 'tool.denied', threadId: ctx.threadId, toolName: `mcp__switchboard__${toolName}`, reason, mode })
  return toolText(reason, true)
}

/**
 * Checked after the card, right before the write: while it was open the user
 * may have unlinked the PR or switched to plan mode.
 */
function changedSinceCard(ctx: PrWriteRunContext, ref: PrRef, toolName: string): McpToolResult | null {
  const plan = refusePlanFor(ctx, toolName)
  if (plan) return plan
  const key = prKey(normalizePrRef(ref))
  if (!ctx.pullRequests?.linkedPrs(ctx.chatId).some((r) => prKey(normalizePrRef(r)) === key)) {
    return toolText(`${prLabel(ref)} was unlinked from this chat while the card was open. Nothing was posted.`, true)
  }
  return null
}

function linkCreated(
  access: AgentPullRequestAccess,
  chatId: string,
  repo: RepoRef,
  pr: CreatedPr,
  created: boolean,
): { ref: PrRef; linked: string } {
  const ref: PrRef = { ...repo, number: pr.number }
  const ok = access.linkToChat(chatId, ref, created)
  return {
    ref,
    // The PR tools act only on linked PRs, so they are offered only when the link held.
    linked: ok
      ? 'It is linked to this chat and shows in Reviews, and the pull request tools can act on it now.'
      : 'Linking it to this chat failed, so the pull request tools cannot act on it yet: ask the user to use Link to chat in Reviews.',
  }
}

const PLAN_TOOL: Record<PrWritePlan['kind'], string> = {
  'pr-reply': PR_REPLY_TOOL,
  'pr-resolve': PR_RESOLVE_TOOL,
  'pr-rerun': PR_RERUN_TOOL,
  'pr-comment': PR_COMMENT_TOOL,
  'pr-review': PR_REVIEW_TOOL,
  'pr-create': PR_CREATE_TOOL,
}

/** What the agent is told it asked for, in a denial or a withdrawal. */
export function prWritePlanSummary(plan: PrWritePlan): string {
  switch (plan.kind) {
    case 'pr-reply':
      return `the reply on ${prLabel(plan.ref)}${plan.location ? ` at ${plan.location}` : ''}`
    case 'pr-resolve':
      return `resolving the conversation${plan.location ? ` at ${plan.location}` : ''} on ${prLabel(plan.ref)}`
    case 'pr-rerun':
      return `re-running ${plan.checkName} on ${prLabel(plan.ref)}`
    case 'pr-comment':
      return `the comment at ${lineLocation(plan.target)} on ${prLabel(plan.ref)}`
    case 'pr-review':
      return `the review of ${prLabel(plan.ref)}`
    case 'pr-create':
      return `opening a pull request from ${plan.source} into ${plan.target} on ${plan.repo.owner}/${plan.repo.name}`
  }
}

/**
 * Run a write the user approved (or, for a create in full access, that needs
 * no card), with the card's response. Every check after the card runs here:
 * plan mode, the link, the PR re-read the host write does itself.
 */
export async function runPrWritePlan(
  ctx: PrWriteRunContext,
  plan: PrWritePlan,
  response: HostWriteResponse,
  opts: { withoutCard?: boolean } = {},
): Promise<McpToolResult> {
  const access = ctx.pullRequests
  if (!access) return toolText('Reviews is not available on this backend, so nothing was posted.', true)
  if (plan.kind === 'pr-create') return runCreate(ctx, access, plan, response, opts.withoutCard === true)
  const changed = changedSinceCard(ctx, plan.ref, PLAN_TOOL[plan.kind])
  if (changed) return changed
  const ref = plan.ref

  if (plan.kind === 'pr-reply') {
    const final = response.text === undefined ? checkReplyText(plan.draft) : checkReplyText(response.text)
    if (!final.ok) return toolText(`The edited reply was refused: ${final.message} Nothing was posted.`, true)
    const resolve = !plan.conversationResolved && (response.resolve ?? plan.suggestResolve)
    const posted = await access.reply(ref, { conversationId: plan.conversationId, body: withViaMarker(final.text) })
    if (!posted.ok) return toolText(`Posting failed: ${posted.error.message} Nothing was posted.`, true)
    log.info('agent reply posted', { host: ref.host, number: ref.number, resolve })

    const edited = final.text !== plan.draft ? ` The user edited your reply first; what was posted:\n${final.text}` : ''
    if (!resolve)
      return toolText(
        `Posted the reply on ${prLabel(ref)}${plan.location ? ` at ${plan.location}` : ''}. The conversation stays open.${edited}`,
      )
    // The post can take a while: check the link and the mode again before the second write.
    if (changedSinceCard(ctx, ref, PR_REPLY_TOOL)) {
      return toolText(
        `Posted the reply on ${prLabel(ref)}, but did not resolve the conversation: the chat's link or mode changed while the reply was posting. Do not post the reply again.${edited}`,
        true,
      )
    }
    const resolved = await access.setResolved(ref, { conversationId: plan.conversationId }, true)
    if (!resolved.ok) {
      return toolText(
        `Posted the reply, but resolving the conversation failed: ${resolved.error.message} Do not post the reply again.${edited}`,
        true,
      )
    }
    return toolText(`Posted the reply on ${prLabel(ref)} and resolved the conversation.${edited}`)
  }

  if (plan.kind === 'pr-resolve') {
    const done = await access.setResolved(ref, { conversationId: plan.conversationId }, true)
    if (!done.ok) return toolText(`Resolving failed: ${done.error.message}`, true)
    return toolText(`Resolved the conversation${plan.location ? ` at ${plan.location}` : ''} on ${prLabel(ref)}.`)
  }

  if (plan.kind === 'pr-rerun') {
    const done = await access.rerunCheck(ref, { checkId: plan.checkId })
    if (!done.ok) return toolText(`Re-running failed: ${done.error.message}`, true)
    return toolText(`Re-running ${plan.checkName} on ${prLabel(ref)}. Check back with ${PR_STATUS_TOOL} later.`)
  }

  if (plan.kind === 'pr-comment') {
    const where = lineLocation(plan.target)
    const final = response.text === undefined ? checkCommentText(plan.draft) : checkCommentText(response.text)
    if (!final.ok) return toolText(`The edited comment was refused: ${final.message} Nothing was posted.`, true)
    const posted = await access.inlineComment(ref, { ...plan.target, body: withViaMarker(final.value) })
    if (!posted.ok) return toolText(`Posting failed: ${posted.error.message} Nothing was posted.`, true)
    log.info('agent line comment posted', { host: ref.host, number: ref.number })
    const edited =
      final.value !== plan.draft ? ` The user edited your comment first; what was posted:\n${final.value}` : ''
    return toolText(`Posted the comment at ${where} on ${prLabel(ref)}.${edited}`)
  }

  const review = plan.review
  const final = reviewFromResponse(ref.host, review, response)
  if (!final.ok) return toolText(final.message, true)
  const { verdict } = final.value
  const submitted = await access.submitReview(ref, {
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
    return toolText(
      posted > 0
        ? `Submitting the review failed part way: ${submitted.error.message} ${posted} of its comments were posted. Do not submit it again; tell the user.`
        : `Submitting the review failed: ${submitted.error.message} Nothing was posted.`,
      true,
    )
  }
  log.info('agent review submitted', {
    host: ref.host,
    number: ref.number,
    verdict,
    comments: final.value.comments.length,
  })
  const notes = [
    final.value.removed > 0 ? `removed ${final.value.removed} of your comments` : '',
    final.value.edited > 0 ? `edited ${final.value.edited}` : '',
    final.value.summary !== review.summary ? 'edited the summary' : '',
  ].filter(Boolean)
  return toolText(
    `The user submitted the review on ${prLabel(ref)} as ${REVIEW_EVENT_LABEL[verdict]}, with ${final.value.comments.length} inline comments.` +
      `${notes.length > 0 ? ` They ${notes.join(', ')} first.` : ''} Do not post these comments again.`,
  )
}

async function runCreate(
  ctx: PrWriteRunContext,
  access: AgentPullRequestAccess,
  plan: Extract<PrWritePlan, { kind: 'pr-create' }>,
  response: HostWriteResponse,
  withoutCard: boolean,
): Promise<McpToolResult> {
  const { repo, source, target, reviewers } = plan
  const repoLabel = `${repo.owner}/${repo.name}`
  const gated = refusePlanFor(ctx, PR_CREATE_TOOL)
  if (gated) return gated
  // The link rule again: the project must still cover the repository the card named.
  if (!projectCoversRepo(await access.projectRepos(plan.projectPath, { fresh: true }), repo)) {
    return toolText(`This chat's project no longer covers ${repoLabel}. Nothing was created.`, true)
  }

  const title = response.title === undefined ? { ok: true as const, value: plan.title } : checkPrTitle(response.title)
  if (!title.ok) return toolText(`The edited title was refused: ${title.message} Nothing was created.`, true)
  const description =
    response.description === undefined
      ? { ok: true as const, value: plan.description }
      : checkPrDescription(response.description)
  if (!description.ok)
    return toolText(`The edited description was refused: ${description.message} Nothing was created.`, true)
  // No card was shown, so full access must still hold after the awaits above.
  if (withoutCard && createPullRequestGate(ctx.runtimeMode()) !== 'allow') {
    return toolText(
      'The chat left full access before the pull request was opened, so nothing was created. Call again: the user will see an approval card.',
      true,
    )
  }
  const kept = keptReviewers(reviewers, response.reviewers)
  const created = await access.createPullRequest(repo, {
    title: title.value,
    description: withViaMarker(description.value),
    sourceBranch: source,
    targetBranch: target,
    draft: plan.draft,
    ...(kept.length > 0 ? { reviewers: kept.map((r) => r.id) } : {}),
  })
  if (!created.ok) {
    if (!isUncertainCreateFailure(created.error))
      return toolText(`Opening the pull request failed: ${created.error.message} Nothing was created.`, true)
    // The request may have gone out: look before telling the agent anything.
    const after = await access.openPullRequestFor(repo, source)
    if (after.ok && after.data) {
      const { linked } = linkCreated(access, ctx.chatId, repo, after.data, true)
      const unsure =
        kept.length > 0 ? ' Whether its reviewers were asked is not known: tell the user to check them in Reviews.' : ''
      return toolText(
        `Opened ${repoLabel} #${after.data.number}: ${after.data.url} (the host's answer was lost, but the pull request is there). ${linked} Do not open it again.${unsure}`,
      )
    }
    log.warn('agent pull request create result uncertain', { host: repo.host, kind: created.error.kind })
    return toolText(
      `The host did not answer clearly: ${created.error.message} The pull request may or may not have been opened. ` +
        `Do not call ${PR_CREATE_TOOL} again; ask the user to check ${PR_HOST_LABEL[repo.host]} or Reviews.`,
      true,
    )
  }
  const { ref, linked } = linkCreated(access, ctx.chatId, repo, created.data, !created.data.existing)
  if (created.data.existing) {
    const skipped = kept.length > 0 ? ' Its reviewers were not changed; the user can add them in Reviews.' : ''
    return toolText(
      `A pull request for ${source} was opened while the card was open: ${repoLabel} #${ref.number}, ${created.data.url}. ${linked} No new one was created.${skipped}`,
    )
  }
  log.info('agent pull request opened', { host: repo.host, number: ref.number, reviewers: kept.length })
  const removed = reviewers.filter((r) => !kept.some((k) => k.id === r.id))
  const edits = [
    title.value !== plan.title ? `the title to "${title.value}"` : '',
    description.value !== plan.description ? 'the description' : '',
    removed.length > 0 ? `the reviewers, removing ${removed.map(reviewerLabel).join(', ')}` : '',
  ].filter(Boolean)
  const failure = created.data.reviewerFailure
  const asked =
    kept.length === 0
      ? ''
      : failure
        ? ` Asking ${kept
            .filter((r) => failure.reviewers.includes(r.id))
            .map(reviewerLabel)
            .join(', ')} to review failed: ${failure.error.message} ` +
          `The pull request is open either way: do not open it again. Tell the user, who can add them in Reviews.`
        : ` Asked ${kept.map(reviewerLabel).join(', ')} to review it.`
  return toolText(
    `Opened ${repoLabel} #${ref.number}: ${created.data.url} (${source} -> ${target}). ${linked}` +
      `${edits.length > 0 ? ` The user edited ${edits.join(' and ')} first.` : ''}${asked}`,
  )
}

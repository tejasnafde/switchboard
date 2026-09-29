/**
 * The rules for a pull request an AGENT asks Switchboard to open
 * (`create_pull_request` on the Switchboard MCP server): what the agent may
 * send, what the card may send back, and the input the service validates
 * again before a host sees it. Pure, so both ends and the tests share them.
 */
import { repoKey, type PrError, type PrHost, type RepoRef } from './pull-requests'
import { parseRemoteUrl } from './pull-request-remote'
import { isReviewerId } from './pull-request-writes'
import { AGENT_PR_MAX_REVIEWERS, checkReviewerNames } from './agent-pr-reviewers'

/** GitHub caps a title at 256 characters, Bitbucket at 255. */
export const PR_TITLE_MAX_CHARS = 255
/** Far below both hosts' caps: a description, not a changelog. */
export const PR_DESCRIPTION_MAX_CHARS = 16_000

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string }

export function checkPrTitle(value: unknown): Checked<string> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: 'The title is empty.' }
  const title = value.trim().replace(/\s+/g, ' ')
  if (title.length > PR_TITLE_MAX_CHARS) return { ok: false, message: `The title is ${title.length} characters; the limit is ${PR_TITLE_MAX_CHARS}.` }
  if (title.includes('\u0000')) return { ok: false, message: 'The title contains a NUL character.' }
  return { ok: true, value: title }
}

/** Empty is allowed; the marker line is added when it is posted. */
export function checkPrDescription(value: unknown): Checked<string> {
  if (value === undefined || value === null) return { ok: true, value: '' }
  if (typeof value !== 'string') return { ok: false, message: 'The description must be text.' }
  const text = value.trim()
  if (text.length > PR_DESCRIPTION_MAX_CHARS) {
    return { ok: false, message: `The description is ${text.length} characters; the limit is ${PR_DESCRIPTION_MAX_CHARS}. Say it shorter.` }
  }
  if (text.includes('\u0000')) return { ok: false, message: 'The description contains a NUL character.' }
  return { ok: true, value: text }
}

/**
 * A branch name git would accept and no command line can read as an option:
 * git's check-ref-format rules, plus no leading `-`.
 */
export function isBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 255) return false
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{') || value === '@') return false
  // Control characters, space, DEL, and what git forbids in a ref name.
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(value)) return false
  return !value.split('/').some((part) => part.startsWith('.'))
}

function checkBranch(value: unknown, what: string): Checked<string | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  const name = typeof value === 'string' ? value.trim().replace(/^refs\/heads\//, '') : value
  if (!isBranchName(name)) return { ok: false, message: `${what} "${String(value)}" is not a branch name.` }
  return { ok: true, value: name }
}

/** "owner/name", a repository URL, or a remote URL: the repository the agent names, if it named one. */
export function parseRepoArg(value: string, host: PrHost): RepoRef | null {
  const text = value.trim()
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text)
  if (short) return { host, owner: short[1], name: short[2] }
  const url = /^https?:\/\/(?:www\.)?(github\.com|bitbucket\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(text)
  if (url) return { host: url[1].toLowerCase() === 'github.com' ? 'github' : 'bitbucket', owner: url[2], name: url[3] }
  return parseRemoteUrl(text)
}

export interface CreatePrArgs {
  title: string
  description: string
  /** Null: the chat checkout's current branch. */
  sourceBranch: string | null
  /** Null: the repository's default branch. */
  targetBranch: string | null
  draft: boolean
  /** Null when the agent did not name one; it must be the chat's repository if it did. */
  repository: string | null
  /** Names, logins or emails as the agent sent them, not yet matched (`resolveReviewers`). */
  reviewers: string[]
}

/** The agent's arguments, before anything is read. */
export function checkCreatePrArgs(args: Record<string, unknown>): Checked<CreatePrArgs> {
  const title = checkPrTitle(args.title)
  if (!title.ok) return title
  const description = checkPrDescription(args.description)
  if (!description.ok) return description
  const source = checkBranch(args.sourceBranch, 'sourceBranch')
  if (!source.ok) return source
  const target = checkBranch(args.targetBranch, 'targetBranch')
  if (!target.ok) return target
  if (args.draft !== undefined && typeof args.draft !== 'boolean') return { ok: false, message: '"draft" is true or false.' }
  if (args.repository !== undefined && typeof args.repository !== 'string') return { ok: false, message: '"repository" is "owner/name" or its URL.' }
  const reviewers = checkReviewerNames(args.reviewers)
  if (!reviewers.ok) return reviewers
  return {
    ok: true,
    value: {
      title: title.value,
      description: description.value,
      sourceBranch: source.value,
      targetBranch: target.value,
      draft: args.draft === true,
      repository: typeof args.repository === 'string' && args.repository.trim() ? args.repository.trim() : null,
      reviewers: reviewers.value,
    },
  }
}

/** Why the agent's named repository is refused, or null when it is the chat's own (or none was named). */
export function repositoryProblem(named: string | null, chatRepo: RepoRef): string | null {
  if (!named) return null
  const ref = parseRepoArg(named, chatRepo.host)
  if (ref && repoKey(ref) === repoKey(chatRepo)) return null
  return `This chat can only open pull requests on ${chatRepo.owner}/${chatRepo.name}, the repository its project points at. ` +
    `"${named}" is not that repository. Nothing was created.`
}

/** A draft on Bitbucket is refused rather than silently opened ready for review. */
export function draftProblem(host: PrHost, draft: boolean): string | null {
  if (!draft || host !== 'bitbucket') return null
  return 'Switchboard opens Bitbucket pull requests ready for review only; it cannot open a draft there. ' +
    'Call again without "draft", or tell the user. Nothing was created.'
}

/** What the service sends a host. The description already ends with the marker line. */
export interface CreatePrInput {
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  draft: boolean
  /** Reviewer ids (`PrReviewerCandidate.id`) the card kept; absent when there are none. */
  reviewers?: string[]
}

export interface CreatedPr {
  number: number
  url: string
}

/**
 * A pull request the host opened. On GitHub the reviewers are a second
 * request after the create; when it fails the pull request still exists, so
 * the failure rides along instead of failing the create.
 */
export interface OpenedPr extends CreatedPr {
  reviewerFailure?: { reviewers: string[]; error: PrError }
}

/** The same rules again, in the service, for whatever reached it. */
export function validateCreatePr(host: PrHost, input: unknown): { ok: true; value: CreatePrInput } | { ok: false; error: PrError } {
  const invalid = (message: string) => ({ ok: false as const, error: { kind: 'invalid' as const, host, message } })
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('The pull request is missing.')
  const r = input as Record<string, unknown>
  const title = checkPrTitle(r.title)
  if (!title.ok) return invalid(title.message)
  if (typeof r.description !== 'string') return invalid('The description is missing.')
  // The marker line may take it a little past the agent's cap.
  if (r.description.length > PR_DESCRIPTION_MAX_CHARS + 100 || r.description.includes('\u0000')) return invalid('The description is too long.')
  if (!isBranchName(r.sourceBranch) || !isBranchName(r.targetBranch)) return invalid('Not a branch name.')
  if (r.sourceBranch === r.targetBranch) return invalid('The source and target branch are the same.')
  const draft = r.draft === true
  const refused = draftProblem(host, draft)
  if (refused) return invalid(refused)
  const reviewers = r.reviewers ?? []
  if (!Array.isArray(reviewers) || reviewers.length > AGENT_PR_MAX_REVIEWERS || !reviewers.every((id) => isReviewerId(host, id))) return invalid('Not a reviewer on this host.')
  if (new Set(reviewers).size !== reviewers.length) return invalid('A reviewer is listed twice.')
  const value: CreatePrInput = { title: title.value, description: r.description, sourceBranch: r.sourceBranch, targetBranch: r.targetBranch, draft }
  if (reviewers.length > 0) value.reviewers = reviewers
  return { ok: true, value }
}

/**
 * A failure that says nothing about whether the host created the pull
 * request: the request may have gone out (a timeout, a dropped connection).
 */
export function isUncertainCreateFailure(error: PrError): boolean {
  return error.kind === 'offline' || error.kind === 'unknown'
}

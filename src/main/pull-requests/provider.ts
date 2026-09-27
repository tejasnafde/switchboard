/**
 * The one interface every pull request host implements: the reads, and the
 * human write actions. Writes get inputs the service already validated and
 * checked against a fresh read (`shared/pull-request-writes.ts`); a
 * provider only shapes the host request and classifies its answer.
 */
import type { InlineCommentInput, SubmitReviewInput } from '@shared/pull-request-writes'
import type {
  MergeStrategy,
  PrChangedFile,
  PrCheck,
  PrConversation,
  PrDetail,
  PrError,
  PrHost,
  PrRef,
  PrSummary,
  RepoRef,
} from '@shared/pull-requests'

export interface RepoListResult {
  repo: RepoRef
  /** `projectPaths` is left empty; the service fills it in. */
  prs: PrSummary[]
  error: PrError | null
}

export interface PullRequestProvider {
  readonly host: PrHost
  list(repos: RepoRef[]): Promise<RepoListResult[]>
  detail(ref: PrRef): Promise<PrDetail>
  files(ref: PrRef): Promise<PrChangedFile[]>
  conversations(ref: PrRef): Promise<PrConversation[]>
  checks(ref: PrRef): Promise<PrCheck[]>

  reply(ref: PrRef, conversationId: string, body: string): Promise<void>
  setResolved(ref: PrRef, conversationId: string, resolved: boolean): Promise<void>
  /** A comment on the whole pull request. */
  comment(ref: PrRef, body: string): Promise<void>
  /** One line comment, posted now rather than held for a review. */
  inlineComment(ref: PrRef, comment: InlineCommentInput): Promise<void>
  submitReview(ref: PrRef, review: SubmitReviewInput): Promise<void>
  merge(ref: PrRef, strategy: MergeStrategy, headSha: string): Promise<void>
  /** `check.rerunId` is set; the service checked it is a failed check of this PR. */
  rerunCheck(ref: PrRef, check: PrCheck): Promise<void>
}

/** A host failure already classified for the UI. Providers throw it; the service turns it into a result. */
export class PrHostError extends Error {
  constructor(readonly error: PrError) {
    super(error.message)
    this.name = 'PrHostError'
  }
}

export function toPrError(err: unknown, host: PrHost | null): PrError {
  if (err instanceof PrHostError) return err.error
  return { kind: 'unknown', host, message: err instanceof Error ? err.message : String(err) }
}

export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

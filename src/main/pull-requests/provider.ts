/**
 * The one interface every pull request host implements. Read-only in this
 * release: no method writes to the host.
 */
import type {
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

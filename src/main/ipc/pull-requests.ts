/**
 * Reviews IPC: pull request reads, the human writes, and the source control
 * accounts behind them. Registered on every host (Electron IPC, the phone's WS/TCP, the
 * headless server), so the backend that owns the projects answers. The
 * credential channels are admin-scoped by prefix in `shared/device-auth.ts`,
 * the write channels one by one.
 *
 * The service is module-level so its caches survive a window being closed
 * and reopened (which re-registers the handlers).
 */
import { execFile } from 'node:child_process'
import type { BackendHost } from '../backend/host'
import { PullRequestChannels, PullRequestWriteChannels, SourceControlChannels } from '@shared/ipc-channels'
import type { GithubAccountState, PrListData, PrResult, SourceControlStatus, SourceControlTestResult } from '@shared/pull-requests'
import { applyHidden } from '@shared/pull-request-groups'
import { canLinkToProject, isPrRef, type PrHistoryScanResult, type PrLink, type PrLinkChat, type PrLinkResult } from '@shared/pull-request-links'
import {
  getConversationByThreadId,
  getProjects,
  hidePullRequest,
  linkConversationPullRequest,
  listHiddenPullRequests,
  listUnscannedPullRequestHistoryScanTargets,
  listConversationPullRequests,
  listLinkableChats,
  listPullRequestChats,
  markPullRequestHistoryScanned,
  resolveRootThreadId,
  unhidePullRequest,
  unhidePullRequestKeys,
  unlinkConversationPullRequest,
} from '../db/database'
import type { RuntimeEventBus } from '../provider/event-bus'
import { PullRequestAutoLinker } from '../pull-requests/auto-link'
import {
  MAX_HISTORY_SCAN_CHARS,
  scanPendingPullRequestHistory,
  scanPullRequestHistoryForConversation,
  type PullRequestHistoryScanDeps,
} from '../pull-requests/history-scan'
import { readConversationHistory } from '../pull-requests/history-source'
import { getSafeStorage, userDataDir } from '../runtime'
import { createMainLogger } from '../logger'
import { BitbucketClient, BitbucketProvider, testBitbucket } from '../pull-requests/bitbucket'
import { BitbucketCredentialStore, CredentialStoreError, validateBitbucketInput } from '../pull-requests/credentials'
import { GitHubProvider } from '../pull-requests/github'
import { PrHostError } from '../pull-requests/provider'
import { PullRequestService } from '../pull-requests/service'
import { createDemoPullRequestService } from '../pull-requests/demo'
import { setAgentPullRequestAccess } from '../mcp/pr-tools'

const log = createMainLogger('ipc:pull-requests')
const DEMO = process.env.SB_DEMO_ADAPTER === '1'
const HISTORY_SCAN_START_DELAY_MS = 2_000

function readRemotes(projectPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', projectPath, 'remote', '-v'], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        log.debug('git remote -v failed', { projectPath, err: err.message })
        resolve('')
        return
      }
      resolve(String(stdout))
    })
  })
}

const credentials = new BitbucketCredentialStore(userDataDir, getSafeStorage)
const github = new GitHubProvider()
let bitbucket: { provider: BitbucketProvider; creds: object } | null = null

function bitbucketProvider(): BitbucketProvider | null {
  const creds = credentials.read()
  if (!creds) return null
  if (bitbucket?.creds !== creds) bitbucket = { provider: new BitbucketProvider(new BitbucketClient(creds)), creds }
  return bitbucket.provider
}

let service: PullRequestService | null = null
function getService(): PullRequestService {
  service ??= DEMO
    ? createDemoPullRequestService()
    : new PullRequestService({
      listProjects: () => getProjects().map((p) => p.path),
      readRemotes,
      github: () => github,
      bitbucket: bitbucketProvider,
      bitbucketState: () => credentials.status(),
    })
  return service
}

async function githubState(): Promise<GithubAccountState> {
  if (DEMO) return { state: 'signed_in', login: 'tejas' }
  try {
    return { state: 'signed_in', login: await github.viewerLogin() }
  } catch (err) {
    if (err instanceof PrHostError) {
      if (err.error.kind === 'gh_missing') return { state: 'gh_missing' }
      if (err.error.kind === 'token_rejected') return { state: 'signed_out' }
      return { state: 'unknown', message: err.error.message }
    }
    log.warn('reading the gh login failed', err)
    return { state: 'unknown', message: 'Could not run gh.' }
  }
}

let notifyLinks: (conversationId: string) => void = () => {}
let backgroundHistoryScanStarted = false

/**
 * Auto-links PRs named in a chat's output (see `pull-requests/auto-link.ts`)
 * and tells clients when any chat's links change. Re-attach with each new
 * registry and host, like the push notifier.
 */
export function attachPullRequestAutoLink(bus: RuntimeEventBus, host: BackendHost): () => void {
  notifyLinks = (conversationId) => host.emit(PullRequestChannels.LINKS_CHANGED, { conversationId })
  const linker = new PullRequestAutoLinker({
    conversationFor: (threadId) => {
      const row = getConversationByThreadId(threadId)
      return row ? { id: row.id, projectPath: row.project_path } : null
    },
    repoForProject: (projectPath) => getService().repoFor(projectPath),
    link: (conversationId, ref) => linkConversationPullRequest(conversationId, ref, 'auto'),
    notify: (conversationId) => notifyLinks(conversationId),
  })
  return bus.subscribe((event) => void linker.onEvent(event))
}

function registerLinkHandlers(host: BackendHost): void {
  host.handle(PullRequestChannels.LINKS, (threadId: unknown): PrLink[] =>
    typeof threadId === 'string' ? listConversationPullRequests(threadId) : [])
  host.handle(PullRequestChannels.LINKED_CHATS, (ref: unknown): PrLinkChat[] =>
    isPrRef(ref) ? listPullRequestChats(ref) : [])
  host.handle(PullRequestChannels.LINKABLE_CHATS, async (ref: unknown): Promise<PrLinkChat[]> =>
    isPrRef(ref) ? listLinkableChats(await getService().projectPathsFor(ref)) : [])

  // Same rule as the auto-link: only a PR of the repository the chat's project points at.
  host.handle(PullRequestChannels.LINK, async (threadId: unknown, ref: unknown): Promise<PrLinkResult> => {
    if (typeof threadId !== 'string' || !isPrRef(ref)) return { ok: false, message: 'Not a chat and a pull request.' }
    const chat = getConversationByThreadId(threadId)
    if (!chat) return { ok: false, message: 'That chat no longer exists.' }
    if (!canLinkToProject(ref, await getService().repoFor(chat.project_path))) {
      return { ok: false, message: "This pull request is not on the repository of that chat's project." }
    }
    if (linkConversationPullRequest(chat.id, ref, 'manual')) notifyLinks(chat.id)
    return { ok: true }
  })

  host.handle(PullRequestChannels.UNLINK, (threadId: unknown, ref: unknown): PrLinkResult => {
    if (typeof threadId !== 'string' || !isPrRef(ref)) return { ok: false, message: 'Not a chat and a pull request.' }
    if (unlinkConversationPullRequest(threadId, ref)) notifyLinks(resolveRootThreadId(threadId))
    return { ok: true }
  })

  // Re-scans one chat on request, scanned before or not; same rules as the background scan.
  host.handle(PullRequestChannels.HISTORY_SCAN, async (threadId: unknown): Promise<PrHistoryScanResult> => {
    if (typeof threadId !== 'string') return { ok: false, message: 'Not a chat.' }
    const chat = getConversationByThreadId(threadId)
    if (!chat) return { ok: false, message: 'This chat has no Switchboard record to link to.' }
    try {
      const { linked, capped } = await scanPullRequestHistoryForConversation({ id: chat.id, projectPath: chat.project_path }, historyScanDeps())
      return { ok: true, linked, capped, capChars: MAX_HISTORY_SCAN_CHARS }
    } catch (err) {
      log.warn('scanning a chat for pull requests failed', { threadId, err: String(err) })
      return { ok: false, message: 'Could not read this chat; see the log.' }
    }
  })
}

function historyScanDeps(): PullRequestHistoryScanDeps {
  return {
    listUnscanned: listUnscannedPullRequestHistoryScanTargets,
    readHistory: readConversationHistory,
    repoForProject: (projectPath) => getService().repoFor(projectPath),
    link: (conversationId, ref) => linkConversationPullRequest(conversationId, ref, 'auto'),
    notify: (conversationId) => notifyLinks(conversationId),
    markScanned: (conversationId) => markPullRequestHistoryScanned(conversationId),
  }
}

/**
 * Scans the stored history of every chat not scanned yet, once, shortly after
 * launch. Call after `attachPullRequestAutoLink`, so new links reach clients.
 */
export function startPullRequestHistoryScan(): void {
  // The demo adapter's fixture stays as seeded, for the visual harness.
  if (backgroundHistoryScanStarted || DEMO) return
  backgroundHistoryScanStarted = true
  setTimeout(() => {
    void scanPendingPullRequestHistory(historyScanDeps()).then((results) => {
      if (results.length === 0) return
      log.info('pull request history scan finished', {
        chats: results.length,
        linked: results.reduce((sum, result) => sum + result.linked, 0),
        capped: results.filter((result) => result.capped).length,
      })
    }).catch((err) => {
      log.warn('pull request history scan failed', err)
    })
  }, HISTORY_SCAN_START_DELAY_MS)
}

/** Marks the PRs the user hid, and clears the hides whose PR came back (`hiddenComesBack`). */
function withHidden(result: PrResult<PrListData>): PrResult<PrListData> {
  if (!result.ok) return result
  try {
    const { hidden, cameBack } = applyHidden(result.data.prs, listHiddenPullRequests(), result.data.fetchedAt)
    if (cameBack.length > 0) {
      unhidePullRequestKeys(cameBack)
      log.info('hidden pull requests came back', { count: cameBack.length })
    }
    return { ok: true, data: { ...result.data, hidden } }
  } catch (err) {
    log.warn('reading hidden pull requests failed', err)
    return result
  }
}

function registerHideHandlers(host: BackendHost): void {
  const toggle = (hide: boolean) => (ref: unknown): { ok: boolean; message?: string } => {
    if (!isPrRef(ref)) return { ok: false, message: 'Not a pull request.' }
    try {
      if (hide) hidePullRequest(ref)
      else unhidePullRequest(ref)
      return { ok: true }
    } catch (err) {
      log.warn('saving a hidden pull request failed', err)
      return { ok: false, message: 'Could not save that; see the log.' }
    }
  }
  host.handle(PullRequestChannels.HIDE, toggle(true))
  host.handle(PullRequestChannels.UNHIDE, toggle(false))
}

export function registerPullRequestHandlers(host: BackendHost): void {
  registerLinkHandlers(host)
  registerHideHandlers(host)
  // The agent tools of the Switchboard MCP server read and write through the
  // same service, so the host re-reads and validation apply to them too.
  setAgentPullRequestAccess({
    linkedPrs: (chatId) => listConversationPullRequests(chatId).map((link) => link.ref),
    detail: (ref) => getService().detail(ref),
    conversations: (ref) => getService().conversations(ref),
    files: (ref) => getService().files(ref),
    reply: (ref, input) => getService().reply(ref, input),
    setResolved: (ref, input, resolved) => getService().setResolved(ref, input, resolved),
    rerunCheck: (ref, input) => getService().rerunCheck(ref, input),
    inlineComment: (ref, input) => getService().inlineComment(ref, input),
    submitReview: (ref, input) => getService().submitReview(ref, input),
  })
  host.handle(PullRequestChannels.LIST, async () => withHidden(await getService().list()))
  host.handle(PullRequestChannels.DETAIL, (ref: unknown) => getService().detail(ref))
  host.handle(PullRequestChannels.FILES, (ref: unknown) => getService().files(ref))
  host.handle(PullRequestChannels.CONVERSATIONS, (ref: unknown) => getService().conversations(ref))
  host.handle(PullRequestChannels.CHECKS, (ref: unknown) => getService().checks(ref))
  host.handle(PullRequestChannels.REVIEWER_CANDIDATES, (ref: unknown) => getService().reviewerCandidates(ref))

  host.handle(PullRequestWriteChannels.REPLY, (ref: unknown, input: unknown) => getService().reply(ref, input))
  host.handle(PullRequestWriteChannels.RESOLVE, (ref: unknown, input: unknown) => getService().setResolved(ref, input, true))
  host.handle(PullRequestWriteChannels.UNRESOLVE, (ref: unknown, input: unknown) => getService().setResolved(ref, input, false))
  host.handle(PullRequestWriteChannels.COMMENT, (ref: unknown, input: unknown) => getService().comment(ref, input))
  host.handle(PullRequestWriteChannels.INLINE_COMMENT, (ref: unknown, input: unknown) => getService().inlineComment(ref, input))
  host.handle(PullRequestWriteChannels.SUBMIT_REVIEW, (ref: unknown, input: unknown) => getService().submitReview(ref, input))
  host.handle(PullRequestWriteChannels.MERGE, (ref: unknown, input: unknown) => getService().merge(ref, input))
  host.handle(PullRequestWriteChannels.RERUN_CHECK, (ref: unknown, input: unknown) => getService().rerunCheck(ref, input))
  host.handle(PullRequestWriteChannels.ADD_REVIEWER, (ref: unknown, input: unknown) => getService().addReviewer(ref, input))
  host.handle(PullRequestWriteChannels.REMOVE_REVIEWER, (ref: unknown, input: unknown) => getService().removeReviewer(ref, input))
  host.handle(PullRequestWriteChannels.DECLINE, (ref: unknown) => getService().decline(ref))

  host.handle(SourceControlChannels.STATUS, async (): Promise<SourceControlStatus> => ({
    bitbucket: DEMO ? { state: 'configured', email: 'tejas@example.com' } : credentials.status(),
    github: await githubState(),
  }))

  host.handle(SourceControlChannels.SET_BITBUCKET, (input: unknown): { ok: boolean; message?: string } => {
    try {
      credentials.save(validateBitbucketInput(input))
      return { ok: true }
    } catch (err) {
      if (err instanceof CredentialStoreError) return { ok: false, message: err.message }
      log.error('saving Bitbucket credentials failed', err instanceof Error ? err.message : 'error')
      return { ok: false, message: 'Saving failed; see the log.' }
    }
  })

  // A failed removal still rejects, so the Settings card reports it instead of showing the account as gone.
  host.handle(SourceControlChannels.REMOVE_BITBUCKET, () => {
    try {
      credentials.remove()
    } catch (err) {
      log.error('removing Bitbucket credentials failed', err instanceof Error ? err.message : 'error')
      throw err
    }
    bitbucket = null
    return { ok: true }
  })

  /** Tests the saved account, or the email + token typed in the form before saving. */
  host.handle(SourceControlChannels.TEST, async (hostName: unknown, input?: unknown): Promise<SourceControlTestResult> => {
    if (hostName === 'github') {
      const state = await githubState()
      if (state.state === 'signed_in') return { ok: true, message: `Signed in to gh as ${state.login}.` }
      if (state.state === 'gh_missing') return { ok: false, message: 'gh is not installed where the backend runs. Install it, then run gh auth login.' }
      if (state.state === 'signed_out') return { ok: false, message: 'gh is signed out. Run gh auth login in a terminal.' }
      return { ok: false, message: state.message }
    }
    if (hostName !== 'bitbucket') return { ok: false, message: 'Unknown host.' }
    if (DEMO) return { ok: true, message: 'Signed in as Tejas.\nAll 3 project repositories are readable.' }
    if (credentials.status().state === 'needs_desktop') return { ok: false, message: 'Bitbucket needs the desktop app in this release.' }
    let creds
    try {
      creds = input ? validateBitbucketInput(input) : credentials.read()
    } catch (err) {
      if (err instanceof CredentialStoreError) return { ok: false, message: err.message }
      throw err
    }
    if (!creds) return { ok: false, message: 'Enter an email and API token first.' }
    const repos = [...(await getService().detect()).repos.values()].map((e) => e.repo).filter((r) => r.host === 'bitbucket')
    return testBitbucket(new BitbucketClient(creds), repos)
  })
}

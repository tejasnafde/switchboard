/**
 * Reviews IPC: pull request reads and the source control accounts behind
 * them. Registered on every host (Electron IPC, the phone's WS/TCP, the
 * headless server), so the backend that owns the projects answers. The
 * credential channels are admin-scoped by prefix in `shared/device-auth.ts`.
 *
 * The service is module-level so its caches survive a window being closed
 * and reopened (which re-registers the handlers).
 */
import { execFile } from 'node:child_process'
import type { BackendHost } from '../backend/host'
import { PullRequestChannels, SourceControlChannels } from '@shared/ipc-channels'
import type { GithubAccountState, SourceControlStatus, SourceControlTestResult } from '@shared/pull-requests'
import { canLinkToProject, isPrRef, type PrLink, type PrLinkChat, type PrLinkResult } from '@shared/pull-request-links'
import {
  getConversationByThreadId,
  getProjects,
  linkConversationPullRequest,
  listConversationPullRequests,
  listLinkableChats,
  listPullRequestChats,
  resolveRootThreadId,
  unlinkConversationPullRequest,
} from '../db/database'
import type { RuntimeEventBus } from '../provider/event-bus'
import { PullRequestAutoLinker } from '../pull-requests/auto-link'
import { getSafeStorage, userDataDir } from '../runtime'
import { createMainLogger } from '../logger'
import { BitbucketClient, BitbucketProvider, testBitbucket } from '../pull-requests/bitbucket'
import { BitbucketCredentialStore, CredentialStoreError, validateBitbucketInput } from '../pull-requests/credentials'
import { GitHubProvider } from '../pull-requests/github'
import { PrHostError } from '../pull-requests/provider'
import { PullRequestService } from '../pull-requests/service'
import { createDemoPullRequestService } from '../pull-requests/demo'

const log = createMainLogger('ipc:pull-requests')
const DEMO = process.env.SB_DEMO_ADAPTER === '1'

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
}

export function registerPullRequestHandlers(host: BackendHost): void {
  registerLinkHandlers(host)
  host.handle(PullRequestChannels.LIST, () => getService().list())
  host.handle(PullRequestChannels.DETAIL, (ref: unknown) => getService().detail(ref))
  host.handle(PullRequestChannels.FILES, (ref: unknown) => getService().files(ref))
  host.handle(PullRequestChannels.CONVERSATIONS, (ref: unknown) => getService().conversations(ref))
  host.handle(PullRequestChannels.CHECKS, (ref: unknown) => getService().checks(ref))

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
    if (DEMO) return { ok: true, message: 'Works for 3 repositories in geoiq.', workspaces: [{ name: 'geoiq', repositories: 3 }] }
    if (credentials.status().state === 'needs_desktop') return { ok: false, message: 'Bitbucket needs the desktop app in this release.' }
    let creds
    try {
      creds = input ? validateBitbucketInput(input) : credentials.read()
    } catch (err) {
      if (err instanceof CredentialStoreError) return { ok: false, message: err.message }
      throw err
    }
    if (!creds) return { ok: false, message: 'Enter an email and API token first.' }
    return testBitbucket(new BitbucketClient(creds))
  })
}

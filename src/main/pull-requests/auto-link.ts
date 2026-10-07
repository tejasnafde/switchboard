/**
 * Links a chat to a pull request the first time the chat's assistant text, a
 * tool's input or a tool's output names that PR's URL, or a tool's input runs
 * `bbpr <n>` in the chat's own repository (a Bitbucket project only; see
 * `bbpr-targets.ts`), provided the PR is on a repository the chat's project
 * covers (`shared/project-repos.ts`). So a PR opened with `gh pr create` or bbpr in a
 * shell links itself too. Assistant text streams in deltas, so it is scanned
 * whole at the end of the turn; a tool's input and output arrive complete.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import { applyContentText } from '@shared/content-stream'
import { bbprTargetsForInput, toolInputCommand, toolInputCwd } from '@shared/bbpr-command'
import { findPullRequestUrls, projectPrRefs } from '@shared/pull-request-links'
import type { PrRef, RepoRef } from '@shared/pull-requests'
import type { ProjectRepos } from '@shared/project-repos'
import { createMainLogger } from '../logger'
import { bbprNumbersInRepo } from './bbpr-targets'

const log = createMainLogger('pull-requests:auto-link')

/** Assistant text kept per message until its turn ends. */
const MAX_BUFFERED_CHARS = 1_000_000
/** A tool input past this is a file being written, not a command. */
const MAX_TOOL_INPUT_CHARS = 200_000
const MENTIONS_HOST = /github\.com\/|bitbucket\.org\//i

/** A tool call's input as the text the matchers read. */
function toolInputText(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input) ?? ''
  } catch (err) {
    log.debug('tool input is not serialisable', { err: String(err) })
    return ''
  }
}

export interface AutoLinkDeps {
  /** Root conversation id, project and working directory (its worktree, else the project) of a thread, `null` when it has no row. */
  conversationFor(threadId: string): { id: string; projectPath: string; cwd: string } | null
  /** The repositories a project covers (`PullRequestService.projectRepos`). */
  projectRepos(projectPath: string): Promise<ProjectRepos>
  /** The repository a directory's git remotes point at: a directory a `bbpr` command `cd`s into. */
  repoForProject(path: string): Promise<RepoRef | null>
  /** Returns whether a link was added (an existing or removed link returns false). */
  link(conversationId: string, ref: PrRef): boolean
  notify(conversationId: string): void
  /** A scan failed; the agent sees it through `list_thread_pull_requests`. */
  problem?(threadId: string, message: string): void
}

export class PullRequestAutoLinker {
  private text = new Map<string, Map<string, string>>()

  constructor(private readonly deps: AutoLinkDeps) {}

  /** Resolves once any scan the event started has finished (tests await it). */
  onEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === 'content' && event.streamKind === 'assistant') {
      let byMessage = this.text.get(event.threadId)
      if (!byMessage) this.text.set(event.threadId, byMessage = new Map())
      const before = byMessage.get(event.messageId)
      if ((before?.length ?? 0) < MAX_BUFFERED_CHARS) {
        byMessage.set(event.messageId, applyContentText(before, { text: event.text, append: event.append }))
      }
      return Promise.resolve()
    }
    if (event.type === 'tool.started') {
      const input = toolInputText(event.input)
      if (!input || input.length > MAX_TOOL_INPUT_CHARS) return Promise.resolve()
      return this.scan(event.threadId, input, toolInputCommand(input), toolInputCwd(input))
    }
    if (event.type === 'tool.completed' && event.output) return this.scan(event.threadId, event.output)
    if (event.type === 'turn.completed' || (event.type === 'status' && (event.status === 'stopped' || event.status === 'error'))) {
      const byMessage = this.text.get(event.threadId)
      this.text.delete(event.threadId)
      if (byMessage) return this.scan(event.threadId, [...byMessage.values()].join('\n'))
    }
    return Promise.resolve()
  }

  /** `command`: the shell command of a tool input, whose bare `bbpr <n>` numbers count when it runs in the chat's repository. */
  private async scan(threadId: string, text: string, command: string | null = null, commandCwd: string | null = null): Promise<void> {
    const mayHaveBbpr = command !== null && command.includes('bbpr')
    if (!mayHaveBbpr && (!MENTIONS_HOST.test(text) || findPullRequestUrls(text).length === 0)) return
    try {
      const chat = this.deps.conversationFor(threadId)
      if (!chat) return
      const project = await this.deps.projectRepos(chat.projectPath)
      const bbprNumbers = mayHaveBbpr ? await bbprNumbersInRepo(bbprTargetsForInput(command, chat.cwd, commandCwd), project.own, (dir) => this.deps.repoForProject(dir)) : []
      let added = false
      for (const ref of projectPrRefs(text, bbprNumbers, project)) {
        if (this.deps.link(chat.id, ref)) added = true
      }
      if (added) this.deps.notify(chat.id)
    } catch (err) {
      log.warn('auto-linking a pull request failed', { threadId, err: String(err) })
      this.deps.problem?.(threadId, `Linking a pull request this chat named failed: ${String(err)}`)
    }
  }
}

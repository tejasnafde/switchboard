/**
 * Links a chat to a pull request it works on: one a shell command hands to
 * gh as the PR to check out, merge, edit, comment on or review, the new PR
 * `gh pr create` prints, or one fetched for review with bbpr (a URL, or a bare
 * `bbpr <n>` in the chat's own repository for a Bitbucket project; see
 * `bbpr-targets.ts`), provided the PR is on a repository the chat's project
 * covers (`shared/project-repos.ts`). A PR merely mentioned (in the agent's
 * prose, a file it read, `gh pr view` output) is not linked; the agent links
 * one on purpose with `link_pull_request`.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import { bbprTargetsForInput, toolInputCommand, toolInputCwd } from '@shared/bbpr-command'
import { projectPrRefs } from '@shared/pull-request-links'
import { prCommandLinks } from '@shared/pr-command-links'
import type { PrRef, RepoRef } from '@shared/pull-requests'
import type { ProjectRepos } from '@shared/project-repos'
import { createMainLogger } from '../logger'
import { bbprNumbersInRepo } from './bbpr-targets'

const log = createMainLogger('pull-requests:auto-link')

/** A tool input past this is a file being written, not a command. */
const MAX_TOOL_INPUT_CHARS = 200_000

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
  /** Tool calls running `gh pr create`, per thread, whose output is the new PR's URL. */
  private creating = new Map<string, Set<string>>()

  constructor(private readonly deps: AutoLinkDeps) {}

  /** Resolves once any scan the event started has finished (tests await it). */
  onEvent(event: RuntimeEvent): Promise<void> {
    if (event.type === 'tool.started') {
      const input = toolInputText(event.input)
      if (!input || input.length > MAX_TOOL_INPUT_CHARS) return Promise.resolve()
      const command = toolInputCommand(input)
      if (!command) return Promise.resolve()
      const { urls, creates } = prCommandLinks(command)
      if (creates) {
        let ids = this.creating.get(event.threadId)
        if (!ids) this.creating.set(event.threadId, ids = new Set())
        ids.add(event.toolId)
      }
      return this.scan(event.threadId, urls.join('\n'), command, toolInputCwd(input))
    }
    if (event.type === 'tool.completed') {
      const ids = this.creating.get(event.threadId)
      if (!ids?.delete(event.toolId)) return Promise.resolve()
      if (ids.size === 0) this.creating.delete(event.threadId)
      if (event.output) return this.scan(event.threadId, event.output)
    }
    if (event.type === 'status' && event.status === 'stopped') this.creating.delete(event.threadId)
    return Promise.resolve()
  }

  /** `command`: the shell command of a tool input, whose bare `bbpr <n>` numbers count when it runs in the chat's repository. */
  private async scan(threadId: string, text: string, command: string | null = null, commandCwd: string | null = null): Promise<void> {
    const mayHaveBbpr = command !== null && command.includes('bbpr')
    if (!mayHaveBbpr && !text) return
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

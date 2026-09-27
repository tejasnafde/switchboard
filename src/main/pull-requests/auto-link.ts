/**
 * Links a chat to a pull request the first time the chat's assistant text or
 * a tool's output names that PR's URL, provided the PR is on the repository
 * of the chat's own project. Assistant text streams in deltas, so it is
 * scanned whole at the end of the turn; tool output arrives complete.
 */
import type { RuntimeEvent } from '@shared/provider-events'
import { applyContentText } from '@shared/content-stream'
import { canLinkToProject, findPullRequestUrls } from '@shared/pull-request-links'
import type { PrRef, RepoRef } from '@shared/pull-requests'
import { createMainLogger } from '../logger'

const log = createMainLogger('pull-requests:auto-link')

/** Assistant text kept per message until its turn ends. */
const MAX_BUFFERED_CHARS = 1_000_000
const MENTIONS_HOST = /github\.com\/|bitbucket\.org\//i

export interface AutoLinkDeps {
  /** Root conversation id and project of a thread, `null` when it has no row. */
  conversationFor(threadId: string): { id: string; projectPath: string } | null
  repoForProject(projectPath: string): Promise<RepoRef | null>
  /** Returns whether a link was added (an existing or removed link returns false). */
  link(conversationId: string, ref: PrRef): boolean
  notify(conversationId: string): void
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
    if (event.type === 'tool.completed' && event.output) return this.scan(event.threadId, event.output)
    if (event.type === 'turn.completed' || (event.type === 'status' && (event.status === 'stopped' || event.status === 'error'))) {
      const byMessage = this.text.get(event.threadId)
      this.text.delete(event.threadId)
      if (byMessage) return this.scan(event.threadId, [...byMessage.values()].join('\n'))
    }
    return Promise.resolve()
  }

  private async scan(threadId: string, text: string): Promise<void> {
    if (!MENTIONS_HOST.test(text)) return
    const refs = findPullRequestUrls(text)
    if (refs.length === 0) return
    try {
      const chat = this.deps.conversationFor(threadId)
      if (!chat) return
      const repo = await this.deps.repoForProject(chat.projectPath)
      let added = false
      for (const ref of refs) {
        if (canLinkToProject(ref, repo) && this.deps.link(chat.id, ref)) added = true
      }
      if (added) this.deps.notify(chat.id)
    } catch (err) {
      log.warn('auto-linking a pull request failed', { threadId, err: String(err) })
    }
  }
}

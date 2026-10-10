import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ChatMessage } from '@shared/types'
import {
  buildMergeBackSummary,
  formatMergeBackMarker,
  isAfterMergeBackCursor,
  mergeBackAgentBlock,
  mergeBackRowFor,
  mergeBackTextProblem,
  parseMergeBackCursor,
  sameMergeBackCursor,
  withMergeBacks,
  type MergeBackActionResult,
  type MergeBackCursor,
  type MergeBackPreview,
  type MergeBackSummary,
  type MergeBackToken,
} from '@shared/merge-back'
import type { SqliteMergeBackStore, StoredMergeBack } from '../db/merge-backs'
import type { DispatchedUserTurn } from '../provider/durable-turn-acceptance'
import { createMainLogger } from '../logger'

const log = createMainLogger('conversations:merge-back')

/** A fork as merge-back sees it, by ROOT ids. */
export interface MergeBackFork {
  id: string
  title: string
  parentId: string
  /** When the fork was made: the first send starts here. */
  createdAt: number
  worktreePath: string | null
  worktreeBranch: string | null
}

export interface MergeBackParent {
  id: string
  title: string
  archived: boolean
}

export interface MergeBackDeps {
  store: SqliteMergeBackStore
  rootId: (threadId: string) => string
  /** Null when `forkId` is not a fork. */
  fork: (forkId: string) => MergeBackFork | null
  parent: (parentId: string) => MergeBackParent | null
  /** The fork's whole history, as a reload shows it. */
  loadMessages: (forkId: string) => Promise<ChatMessage[]>
  /** True while the fork (root id) is mid-turn: its last result is not in yet. */
  forkBusy: (forkId: string) => boolean
  /** The parent's card changed; `content` null once it is gone. */
  publishRow: (parentId: string, messageId: string, content: string | null, at: number) => void
  now?: () => number
  newId?: () => string
}

/** The pending merge-backs one user turn carries to the parent's agent. */
export interface MergeBackClaim {
  /** The provider text with every claimed summary in front of the user's words. */
  apply: (providerText: string) => string
  /** For the turn's commit: deliver in its transaction, then publish or let go. */
  dispatched: (providerText: string) => DispatchedUserTurn
  /** The turn never reached the agent: the summaries stay pending. */
  release: () => void
}

const BUSY_MESSAGE = 'This summary is going to the agent with a message right now. Try again in a moment.'

export class MergeBackService {
  private readonly deps: MergeBackDeps
  private readonly now: () => number
  private readonly newId: () => string
  /** Merge-back ids riding on a user turn that has not committed yet. */
  private readonly claimed = new Set<string>()

  constructor(deps: MergeBackDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => randomUUID())
  }

  async preview(forkThreadId: string): Promise<MergeBackPreview> {
    const target = this.target(forkThreadId)
    if ('message' in target) return { status: 'refused', message: target.message }
    const { fork, parent } = target
    const from = this.cursorFor(fork)
    const summary = await this.summarize(fork, from, null)
    if (!summary) {
      return {
        status: 'empty',
        parentTitle: parent.title,
        message: this.deps.store.cursorFor(fork.id)
          ? 'Nothing new in this fork since the last send.'
          : 'Nothing to send yet: this fork has no turns since the fork point.',
      }
    }
    return {
      status: 'ready',
      parentId: parent.id,
      parentTitle: parent.title,
      text: summary.text,
      turns: summary.turns,
      omittedTurns: summary.omittedTurns,
      files: summary.files,
      moreFiles: summary.moreFiles,
      replacesPending: this.deps.store.pendingFromFork(fork.id, parent.id) !== null,
      token: { from, through: summary.through },
    }
  }

  /**
   * Store what the preview showed, with the user's text, as a pending card in
   * the parent. The token pins the range: a fork that ran on since the preview
   * still sends only what the user saw.
   */
  async send(forkThreadId: string, text: unknown, token: unknown): Promise<MergeBackActionResult> {
    const problem = mergeBackTextProblem(text)
    if (problem) return { ok: false, message: problem }
    const pinned = parseToken(token)
    if (!pinned) return { ok: false, message: 'This summary is out of date. Open Send back again.' }
    const target = this.target(forkThreadId)
    if ('message' in target) return { ok: false, message: target.message }
    const { fork, parent } = target
    if (!sameMergeBackCursor(this.cursorFor(fork), pinned.from)) {
      return { ok: false, message: 'The fork sent back since this summary was made. Open Send back again.' }
    }
    const summary = await this.summarize(fork, pinned.from, pinned.through)
    if (!summary) return { ok: false, message: 'Nothing new to send.' }
    // Building the summary awaited the fork's history: check what the user
    // may have done meanwhile before writing.
    if (!sameMergeBackCursor(this.cursorFor(fork), pinned.from)) {
      return { ok: false, message: 'The fork sent back since this summary was made. Open Send back again.' }
    }
    const pending = this.deps.store.pendingFromFork(fork.id, parent.id)
    if (pending && this.claimed.has(pending.id)) return { ok: false, message: BUSY_MESSAGE }
    const id = this.newId()
    const row = mergeBackRowFor(id, fork, summary, (text as string).trim())
    const { created, replaced } = this.deps.store.createPending({
      id,
      parentId: parent.id,
      forkId: fork.id,
      row,
      through: summary.through,
      now: this.now(),
    })
    if (replaced) this.deps.publishRow(replaced.parentId, replaced.messageId, null, created.createdAt)
    this.publish(created)
    log.info(
      `merge-back ${id} pending: fork ${fork.id} -> parent ${parent.id} turns=${summary.turns} bytes=${Buffer.byteLength(row.text)}`,
    )
    return { ok: true }
  }

  edit(parentThreadId: string, mergeBackId: string, text: unknown): MergeBackActionResult {
    const problem = mergeBackTextProblem(text)
    if (problem) return { ok: false, message: problem }
    const refused = this.refuseChange(parentThreadId, mergeBackId)
    if (refused) return refused
    const edited = this.deps.store.editText(mergeBackId, (text as string).trim(), this.now())
    if (!edited) return { ok: false, message: 'This summary was already sent or discarded.' }
    this.publish(edited)
    return { ok: true }
  }

  discard(parentThreadId: string, mergeBackId: string): MergeBackActionResult {
    const refused = this.refuseChange(parentThreadId, mergeBackId)
    if (refused) return refused
    const discarded = this.deps.store.discard(mergeBackId, this.now())
    if (!discarded) return { ok: false, message: 'This summary was already sent or discarded.' }
    this.deps.publishRow(discarded.parentId, discarded.messageId, null, this.now())
    log.info(`merge-back ${mergeBackId} discarded`)
    return { ok: true }
  }

  /**
   * Take the parent's pending merge-backs for the user turn being sent. Null
   * when there are none. A read failure is logged and sends the turn without
   * them: the summaries stay pending for the next message.
   */
  claimForTurn(threadId: string): MergeBackClaim | null {
    let pending: StoredMergeBack[]
    try {
      pending = this.deps.store.pendingFor(this.deps.rootId(threadId)).filter((p) => !this.claimed.has(p.id))
    } catch (err) {
      log.warn(`reading pending merge-backs for ${threadId} failed; sending the turn without them`, err)
      return null
    }
    if (pending.length === 0) return null
    for (const p of pending) this.claimed.add(p.id)
    let open = true
    const release = () => {
      if (!open) return
      open = false
      for (const p of pending) this.claimed.delete(p.id)
    }
    const blocks = pending.map((p) => mergeBackAgentBlock(p.row.forkTitle, p.row.text))
    return {
      apply: (providerText) => withMergeBacks(providerText, blocks),
      release,
      dispatched: (providerText) => {
        let delivered: ReturnType<SqliteMergeBackStore['markDeliveredInTransaction']> = []
        return {
          providerText,
          commitInTransaction: (db: Database.Database, acceptedAt: number) => {
            delivered = this.deps.store.markDeliveredInTransaction(db, pending, acceptedAt)
          },
          afterCommit: (committed) => {
            release()
            if (!committed) return
            for (const d of delivered) {
              this.deps.publishRow(d.parentId, d.messageId, d.content, d.at)
              log.info(`merge-back ${d.id} delivered to ${d.parentId}`)
            }
          },
        }
      },
    }
  }

  /** Only the parent's own pending card, and not while a turn carries it. */
  private refuseChange(parentThreadId: string, mergeBackId: string): MergeBackActionResult | null {
    const current = typeof mergeBackId === 'string' ? this.deps.store.get(mergeBackId) : null
    if (!current || current.parentId !== this.deps.rootId(parentThreadId) || current.state !== 'pending') {
      return { ok: false, message: 'This summary was already sent or discarded.' }
    }
    if (this.claimed.has(mergeBackId)) return { ok: false, message: BUSY_MESSAGE }
    return null
  }

  private target(forkThreadId: string): { fork: MergeBackFork; parent: MergeBackParent } | { message: string } {
    const fork = this.deps.fork(this.deps.rootId(forkThreadId))
    if (!fork) return { message: 'This chat is not a fork, so it has no parent to send back to.' }
    const parent = this.deps.parent(this.deps.rootId(fork.parentId))
    if (!parent) return { message: 'The chat this fork came from no longer exists.' }
    if (parent.archived) return { message: `"${parent.title}" is archived. Unarchive it to send back to it.` }
    if (this.deps.forkBusy(fork.id)) {
      return { message: 'The fork is still working. Send back once its turn ends.' }
    }
    return { fork, parent }
  }

  private cursorFor(fork: MergeBackFork): MergeBackCursor {
    return this.deps.store.cursorFor(fork.id) ?? { at: fork.createdAt, ids: [] }
  }

  private async summarize(
    fork: MergeBackFork,
    from: MergeBackCursor,
    through: MergeBackCursor | null,
  ): Promise<MergeBackSummary | null> {
    const all = await this.deps.loadMessages(fork.id)
    const messages = through ? all.filter((m) => !isAfterMergeBackCursor(m, through)) : all
    return buildMergeBackSummary(messages, from, {
      title: fork.title,
      worktreePath: fork.worktreePath,
      worktreeBranch: fork.worktreeBranch,
      sentBefore: this.deps.store.cursorFor(fork.id) !== null,
    })
  }

  private publish(stored: StoredMergeBack): void {
    this.deps.publishRow(stored.parentId, stored.messageId, formatMergeBackMarker(stored.row), stored.updatedAt)
  }
}

function parseToken(value: unknown): MergeBackToken | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const from = parseMergeBackCursor(v.from)
  const through = parseMergeBackCursor(v.through)
  return from && through ? { from, through } : null
}

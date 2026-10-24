/**
 * Starting child chats: `start_children` proposes a batch, the batch card (or,
 * in auto-accept edits and above, nothing) approves it, and the runner starts
 * each child.
 *
 * Per child, in order: its `hub_children` row (phase `starting`); a worktree
 * through the worktree creation service (purpose `hub-child`, which skips the
 * background dependency clone), or the project folder for `location:
 * 'project'`; then every dependency folder cloned before the first turn; then
 * the session with the brief as its first turn, once a run slot is free. One
 * child failing marks it `failed_start` with a `failed` wake, and the batch
 * goes on. A child never gets more access than its parent (`grantedMode`).
 *
 * Measured: one `hub.batch` and one `hub.start-child` perf line per batch and
 * child (outcome and the time of each step), `hub.child-turn` per child turn
 * end (tokens, cost, duration), and the worktree's disk use after start.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  HUB_MAIN_CHECKOUT_WARNING,
  HUB_OPEN_CHILDREN_MAX,
  grantedMode,
  hubBatchDetail,
  hubBriefTurn,
  hubDiskProblem,
  hubNeedsCard,
  isOpenChildPhase,
  readHubSettings,
  runSlotFree,
  type HubBatchView,
  type HubChildLocation,
  type HubDepsMode,
  type HubRunningChild,
  type HubTask,
} from '@shared/hub'
import type { SettingReader } from '@shared/limit-resume'
import type { RuntimeMode, UserTurnSubmissionResult, UserTurnSubmissionV1 } from '@shared/provider-events'
import { providerKindFor, type AgentProvider } from '@shared/types'
import {
  WORKTREE_CREATION_SCHEMA_VERSION,
  type WorktreeCreationRequest,
  type WorktreeCreationSnapshot,
} from '@shared/worktree-creation'
import { formatApprovalResultMarker } from '@shared/agent-approval-cards'
import {
  createConversation,
  createHubBatch,
  ensureHubParent,
  findProposedHubBatch,
  getHubBatch,
  getHubChild,
  insertHubChild,
  insertHubWake,
  listHubChildren,
  listHubChildrenInPhase,
  openChildParentId,
  resolveRootThreadId,
  saveMessageIfAbsent,
  setConversationProviderInstanceId,
  setConversationRuntimeMode,
  setHubBatchStatus,
  updateHubChild,
} from '../db/database'
import { resolveProviderInstance } from '../db/provider-instances'
import type { SessionStartOpts } from '../provider/types'
import { cloneDependencyDirs, findDependencyDirs } from '../git/dependency-clone'
import { toolText, type McpToolResult } from '../mcp/mcp-session'
import { createMainLogger } from '../logger'
import { perfSpan } from '../perf'

const log = createMainLogger('hub:start')
const execFileP = promisify(execFile)

/** A batch as its card stores it: the approval runs `batchId`. */
export interface HubBatchPlan {
  kind: 'hub-batch'
  batchId: string
  view: HubBatchView
}

export function isHubBatchPlan(plan: { kind: string }): plan is HubBatchPlan {
  return plan.kind === 'hub-batch'
}

/** One child, resolved when the batch is proposed. Stored as `hub_batches.plan_json`. */
interface PlannedChild {
  childId: string
  ordinal: number
  title: string
  brief: string
  location: HubChildLocation
  baseRef: string
  baseSha: string | null
  branchSeed: string
  agent: AgentProvider
  instanceId: string | null
  model: string | null
  requestedMode: RuntimeMode | null
  /** The mode the card showed: approval never grants more, even if the parent's mode rose since. */
  shownMode: RuntimeMode
  deps: HubDepsMode
}

interface StoredPlan {
  projectPath: string
  children: PlannedChild[]
}

/** The calling chat, as the registry sees it. */
export interface HubParentContext {
  /** The id its session runs under. */
  threadId: string
  /** Its root conversation id. */
  parentId: string
  projectPath: string
  cwd: string
  mode: RuntimeMode
  agent: AgentProvider
  instanceId: string | null
}

let worktreeCreator: ((request: WorktreeCreationRequest) => Promise<WorktreeCreationSnapshot>) | null = null

/** The backend's worktree creation service, set once it exists (`createDefaultWorktreeCreationRuntime`). */
export function configureHubWorktreeCreator(
  create: (request: WorktreeCreationRequest) => Promise<WorktreeCreationSnapshot>,
): void {
  worktreeCreator = create
}

export function hubWorktreeCreator(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot> {
  if (!worktreeCreator) return Promise.reject(new Error('The worktree creation service is not ready.'))
  return worktreeCreator(request)
}

export interface HubStartHost {
  createWorktree(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
  startSession(opts: SessionStartOpts): Promise<unknown>
  submitTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult>
  /** Opens the batch card on the parent; the approval comes back through `approve`. */
  openCard(input: { threadId: string; parentId: string; detail: string; plan: HubBatchPlan }):
    | { ok: true; requestId: string }
    | { ok: false; message: string }
  /** A new system row in the parent's chat, for clients to show. */
  announceRow(parentId: string, row: { messageId: string; requestId: string; content: string }): void
}

/** Git and disk reads, replaceable in tests. */
export interface HubStartIo {
  freeBytes(path: string): Promise<number | null>
  /** Bytes of the tracked files at `sha`: what a worktree checkout writes. */
  checkoutBytes(projectPath: string, sha: string): Promise<number | null>
  dirBytes(path: string): Promise<number | null>
  dependencyDirs(projectPath: string): Promise<string[]>
  cloneDependencyDir(projectPath: string, worktreePath: string, dir: string): Promise<boolean>
  isMainCheckout(cwd: string): Promise<boolean>
  commitOf(cwd: string, ref: string): Promise<string | null>
}

/** A clone costs about this share of the folder (copy-on-write metadata). */
const CLONE_SHARE = 0.05
const DIR_BYTES_TTL_MS = 10 * 60_000

export class HubStarter {
  private readonly io: HubStartIo
  private readonly running = new Map<string, HubRunningChild>()
  private readonly waiting: Array<{ childId: string; slot: HubRunningChild; go: () => void }> = []
  private readonly lastTurn = new Map<string, { usedTokens?: number; costUsd?: number; at: number }>()
  private readonly diskUse = new Map<string, number>()
  /** Children this process launched, to their parents. A restart forgets them; restart recovery comes later. */
  private readonly launched = new Map<string, string>()

  constructor(
    private readonly host: HubStartHost,
    private readonly getSetting: SettingReader,
    io: Partial<HubStartIo> = {},
  ) {
    this.io = { ...defaultIo(), ...io }
  }

  /**
   * Children left in `starting` by a quit never got their first turn. They
   * are marked failed with a wake; the worktree creation service finishes or
   * rolls back their worktrees on its own.
   */
  recoverInterrupted(): void {
    for (const child of listHubChildrenInPhase('starting')) {
      updateHubChild(child.childId, { phase: 'failed_start' })
      this.failedWake(child.parentId, child.childId, 'Start was cut off when Switchboard quit.')
      log.info('child start cut off by a quit', { childId: child.childId, parentId: child.parentId })
    }
  }

  /** The parent of an open child, or null. A failed read counts as no child: the database is down for every path then. */
  parentOfOpenChild(threadId: string): string | null {
    try {
      return openChildParentId(threadId)
    } catch (err) {
      log.warn(`could not read hub membership of ${threadId}`, err)
      return null
    }
  }

  isOpenChild(threadId: string): boolean {
    return this.parentOfOpenChild(threadId) !== null
  }

  waitingForSlot(childId: string): boolean {
    return this.waiting.some((w) => w.childId === childId)
  }

  lastTurnOf(childId: string): { usedTokens?: number; costUsd?: number; at: number } | undefined {
    return this.lastTurn.get(childId)
  }

  diskUseOf(childId: string): number | undefined {
    return this.diskUse.get(childId)
  }

  /** `start_children`: validate, check the disk, and open the card or start at once. */
  async propose(ctx: HubParentContext, tasks: HubTask[]): Promise<McpToolResult> {
    if (openChildParentId(ctx.parentId)) return toolText('A child chat cannot start children of its own.', true)
    if (ctx.mode === 'plan')
      return toolText('Plan mode does not start child chats. Ask the user to leave plan mode first.', true)
    const capProblem = openCapProblem(ctx.parentId, tasks.length)
    if (capProblem) return toolText(capProblem, true)

    const settings = readHubSettings(this.getSetting)
    const deps: HubDepsMode = settings.childDependencies === 'none' ? 'none' : 'clone'
    const head = await this.io.commitOf(ctx.cwd, 'HEAD')
    const children: PlannedChild[] = []
    for (const [i, task] of tasks.entries()) {
      const agent = task.agent ?? ctx.agent
      let instanceId: string | null
      try {
        instanceId =
          resolveProviderInstance(agent, task.account ?? (agent === ctx.agent ? ctx.instanceId : null))?.id ?? null
      } catch (err) {
        return toolText(`Task ${i + 1}: ${err instanceof Error ? err.message : String(err)}`, true)
      }
      let baseSha: string | null = null
      if (task.location === 'worktree') {
        baseSha = task.baseRef ? await this.io.commitOf(ctx.cwd, task.baseRef) : head
        if (!baseSha)
          return toolText(
            task.baseRef
              ? `Task ${i + 1}: base ${task.baseRef} is not a commit here. Fetch it first, or name another.`
              : `Task ${i + 1}: this chat's folder is not a git checkout. Use location "project".`,
            true,
          )
      }
      children.push({
        childId: `agent_${Date.now()}_${randomBytes(4).toString('hex')}`,
        ordinal: i,
        title: task.title,
        brief: task.brief,
        location: task.location,
        baseRef: task.baseRef ?? 'HEAD',
        baseSha,
        branchSeed: task.branch ?? task.title,
        agent,
        instanceId,
        model: task.model ?? null,
        requestedMode: task.mode ?? null,
        shownMode: grantedMode(task.mode, ctx.mode),
        deps: task.location === 'project' ? 'none' : deps,
      })
    }

    const plan: StoredPlan = { projectPath: ctx.projectPath, children }
    const disk = await this.diskCheck(plan)
    if (disk.problem) return toolText(disk.problem, true)
    const batchId = `hb_${Date.now()}_${randomBytes(4).toString('hex')}`
    const view: HubBatchView = {
      batchId,
      rows: children.map((c) => ({
        title: c.title,
        agent: c.agent,
        account: c.instanceId,
        model: c.model,
        mode: c.shownMode,
        location: c.location,
        baseRef: c.baseSha ? `${c.baseRef} (${c.baseSha.slice(0, 7)})` : c.baseRef,
        deps: c.deps,
      })),
      needBytes: disk.needBytes,
      freeBytes: disk.freeBytes,
      mainCheckout: await this.io.isMainCheckout(ctx.cwd),
    }

    // After the last await, so two identical calls in flight cannot both open a card.
    const digest = planDigest(ctx.parentId, plan)
    const same = findProposedHubBatch(ctx.parentId, digest)
    if (same?.cardRequestId)
      return toolText(`This batch already waits for the user (card ${same.cardRequestId}). Do not send it again.`)

    if (hubNeedsCard(ctx.mode)) {
      const opened = this.host.openCard({
        threadId: ctx.threadId,
        parentId: ctx.parentId,
        detail: hubBatchDetail(view),
        plan: { kind: 'hub-batch', batchId, view },
      })
      if (!opened.ok) return toolText(opened.message, true)
      createHubBatch({
        batchId,
        parentId: ctx.parentId,
        cardRequestId: opened.requestId,
        planJson: JSON.stringify(plan),
        planDigest: digest,
      })
      return toolText(
        `Queued for the user's approval (card ${opened.requestId}). The children start when the user approves; ` +
          'you get a message in this chat with the result. Do not send it again. Carry on with other work, or end your turn.',
      )
    }

    const lateCap = openCapProblem(ctx.parentId, tasks.length)
    if (lateCap) return toolText(lateCap, true)
    createHubBatch({ batchId, parentId: ctx.parentId, cardRequestId: null, planJson: JSON.stringify(plan), planDigest: digest })
    const text = this.startApproved(batchId, ctx.mode, view.mainCheckout)
    this.writeStartedRow(ctx.parentId, batchId, text)
    return toolText(text)
  }

  /** The user approved the card. Checks the parent's mode and the disk again first. */
  async approve(batchId: string, parentMode: RuntimeMode): Promise<McpToolResult> {
    const batch = getHubBatch(batchId)
    if (!batch || batch.status !== 'proposed') return toolText('That batch is no longer waiting.', true)
    if (parentMode === 'plan') {
      setHubBatchStatus(batchId, 'denied')
      return toolText('The chat is in plan mode now, so no children were started.', true)
    }
    const plan = JSON.parse(batch.planJson) as StoredPlan
    const disk = await this.diskCheck(plan)
    // After the last await, so a batch started meanwhile counts.
    const problem = disk.problem ?? openCapProblem(batch.parentId, plan.children.length)
    if (problem) {
      setHubBatchStatus(batchId, 'denied')
      return toolText(`${problem} No children were started.`, true)
    }
    return toolText(this.startApproved(batchId, parentMode, false))
  }

  /** The card closed without an approval. */
  closed(batchId: string, how: 'denied' | 'withdrawn'): void {
    if (getHubBatch(batchId)?.status === 'proposed') setHubBatchStatus(batchId, how)
  }

  /** A turn of some chat ended: frees its run slot and records a child's tokens. */
  onTurnEnded(threadId: string, turn?: { usedTokens?: number; costUsd?: number; durationMs?: number }): void {
    // No database read on this hot path while no child started in this process.
    if (this.launched.size === 0) return
    const childId = resolveRootThreadId(threadId)
    const slot = this.running.get(childId)
    if (slot) this.running.delete(childId)
    if (turn) {
      const parentId = this.launched.get(childId)
      if (parentId) {
        this.lastTurn.set(childId, { usedTokens: turn.usedTokens, costUsd: turn.costUsd, at: Date.now() })
        perfSpan('hub.child-turn', {
          childId,
          parentId,
          usedTokens: turn.usedTokens,
          costUsd: turn.costUsd,
          turnMs: turn.durationMs,
        }).end()
      }
    }
    if (slot) this.pump()
  }

  private startApproved(batchId: string, parentMode: RuntimeMode, mainCheckout: boolean): string {
    const batch = getHubBatch(batchId)!
    setHubBatchStatus(batchId, 'approved')
    const plan = JSON.parse(batch.planJson) as StoredPlan
    ensureHubParent(batch.parentId)
    for (const c of plan.children) {
      insertHubChild({
        childId: c.childId,
        parentId: batch.parentId,
        batchId,
        ordinal: c.ordinal,
        title: c.title,
        brief: c.brief,
        location: c.location,
        grantedMode: grantedMode(c.shownMode, parentMode),
        depsMode: c.deps,
        baseRef: c.baseRef,
        baseSha: c.baseSha,
        providerInstanceId: c.instanceId,
        requestedModel: c.model,
      })
    }
    void this.runBatch(batchId, batch.parentId, plan).catch((err) => log.error(`batch ${batchId} failed`, err))
    const lines = plan.children.map((c) => `- ${c.title}: ${c.childId}`)
    return [
      `Starting ${plan.children.length} child chat${plan.children.length === 1 ? '' : 's'}. Each starts in its own ` +
        'worktree (or the project folder) and gets its brief as its first turn:',
      ...lines,
      ...(mainCheckout ? [HUB_MAIN_CHECKOUT_WARNING, 'Ask the user before you merge into a branch checked out there.'] : []),
    ].join('\n')
  }

  private async runBatch(batchId: string, parentId: string, plan: StoredPlan): Promise<void> {
    const span = perfSpan('hub.batch', { batchId, parentId, children: plan.children.length })
    let failed = 0
    for (const c of plan.children) {
      // Worktrees and clones go one at a time; the agents start as run slots free.
      if (!(await this.prepareChild(batchId, parentId, plan.projectPath, c))) failed++
    }
    span.end({ failed })
  }

  /** Worktree and dependencies; then the launch waits for a slot. False when the child failed. */
  private async prepareChild(batchId: string, parentId: string, projectPath: string, c: PlannedChild): Promise<boolean> {
    const span = perfSpan('hub.start-child', { childId: c.childId, agent: c.agent, location: c.location, deps: c.deps })
    const t0 = performance.now()
    let cwd = projectPath
    let worktreeMs = 0
    let depsMs = 0
    try {
      if (c.location === 'worktree') {
        const snapshot = await this.host.createWorktree(this.worktreeRequest(batchId, parentId, projectPath, c))
        if (snapshot.status !== 'ready' || !snapshot.worktreePath)
          throw new Error(snapshot.error?.message ?? `worktree creation ended ${snapshot.status}`)
        cwd = snapshot.worktreePath
        worktreeMs = performance.now() - t0
        updateHubChild(c.childId, { branch: snapshot.branch ?? null })
        const t1 = performance.now()
        const cloned: string[] = []
        if (c.deps === 'clone') {
          for (const dir of await this.io.dependencyDirs(projectPath))
            if (await this.io.cloneDependencyDir(projectPath, cwd, dir)) cloned.push(dir)
        }
        depsMs = performance.now() - t1
        updateHubChild(c.childId, { depsJson: JSON.stringify({ cloned }) })
        const bytes = await this.io.dirBytes(cwd)
        if (bytes !== null) this.diskUse.set(c.childId, bytes)
        span.end({ outcome: 'prepared', worktreeMs: Math.round(worktreeMs), depsMs: Math.round(depsMs), cloned: cloned.length, diskMb: bytes === null ? null : Math.round(bytes / 1024 ** 2) })
      } else {
        createConversation(c.childId, projectPath, c.agent, c.title)
        span.end({ outcome: 'prepared' })
      }
    } catch (err) {
      span.end({ outcome: 'failed', step: 'prepare' })
      this.fail(parentId, c, err)
      return false
    }
    const mode = getHubChild(c.childId)?.grantedMode ?? 'sandbox'
    setConversationRuntimeMode(c.childId, mode)
    if (c.instanceId) setConversationProviderInstanceId(c.childId, c.instanceId)
    const slot: HubRunningChild = { providerInstanceId: c.instanceId ?? c.agent, parentId }
    void this.whenSlotFree(c.childId, slot)
      .then(() => this.launch(c, cwd, mode, slot))
      .catch((err) => log.error(`launching child ${c.childId} threw`, err))
    return true
  }

  private async launch(c: PlannedChild, cwd: string, mode: RuntimeMode, slot: HubRunningChild): Promise<void> {
    const span = perfSpan('hub.start-child', { childId: c.childId, agent: c.agent, step: 'launch' })
    this.running.set(c.childId, slot)
    this.launched.set(c.childId, slot.parentId)
    try {
      await this.host.startSession({
        threadId: c.childId,
        provider: providerKindFor(c.agent),
        cwd,
        runtimeMode: mode,
        ...(c.instanceId ? { instanceId: c.instanceId } : {}),
        ...(c.model ? { model: c.model } : {}),
      })
      const brief = c.deps === 'none' && c.location === 'worktree'
        ? `${c.brief}\n\nThis worktree has no dependency folders. Install them if the task needs them.`
        : c.brief
      const result = await this.host.submitTurn({
        version: 1,
        threadId: c.childId,
        origin: `hub-brief-${c.childId}`,
        providerText: hubBriefTurn(brief),
        displayBody: c.brief,
        runtimeMode: mode,
      })
      if (result.status === 'rejected' || result.status === 'conflict')
        throw new Error(`the brief was not accepted: ${result.reason}`)
      updateHubChild(c.childId, { phase: 'open' })
      span.end({ outcome: result.status })
    } catch (err) {
      span.end({ outcome: 'failed', step: 'launch' })
      this.running.delete(c.childId)
      this.pump()
      this.fail(slot.parentId, c, err)
    }
  }

  private fail(parentId: string, c: PlannedChild, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`child ${c.childId} failed to start: ${message}`)
    try {
      updateHubChild(c.childId, { phase: 'failed_start' })
      this.failedWake(parentId, c.childId, `Failed to start: ${message}`)
    } catch (writeErr) {
      log.error(`could not record the failed start of ${c.childId}`, writeErr)
    }
  }

  private failedWake(parentId: string, childId: string, summary: string): void {
    insertHubWake({
      id: `hw_${Date.now()}_${randomBytes(4).toString('hex')}`,
      parentId,
      childId,
      kind: 'failed',
      summary,
      pointer: null,
    })
  }

  private whenSlotFree(childId: string, slot: HubRunningChild): Promise<void> {
    const s = readHubSettings(this.getSetting)
    // Only waiters on the same account or parent can be ahead of this child.
    const ahead = this.waiting.some(
      (w) => w.slot.providerInstanceId === slot.providerInstanceId || w.slot.parentId === slot.parentId,
    )
    if (!ahead && runSlotFree(slot, [...this.running.values()], s.runningPerInstance, s.runningPerParent))
      return Promise.resolve()
    log.info('child waits for a run slot', { childId, instance: slot.providerInstanceId })
    return new Promise((go) => this.waiting.push({ childId, slot, go }))
  }

  private pump(): void {
    const s = readHubSettings(this.getSetting)
    for (let i = 0; i < this.waiting.length; ) {
      const w = this.waiting[i]!
      if (runSlotFree(w.slot, [...this.running.values()], s.runningPerInstance, s.runningPerParent)) {
        this.waiting.splice(i, 1)
        // Reserved now, so the next waiter sees it; `launch` sets the same entry.
        this.running.set(w.childId, w.slot)
        w.go()
      } else i++
    }
  }

  private worktreeRequest(batchId: string, parentId: string, projectPath: string, c: PlannedChild): WorktreeCreationRequest {
    return {
      schemaVersion: WORKTREE_CREATION_SCHEMA_VERSION,
      creationId: `${batchId}-${c.ordinal}`,
      repository: { projectPath, machineId: 'local' },
      checkout: {
        baseRef: c.baseSha ?? c.baseRef,
        branch: { namespace: 'hub', seed: c.branchSeed },
        location: 'managed-in-repo',
      },
      owner: { kind: 'conversation', conversationId: c.childId, agentType: c.agent, title: c.title },
      purpose: 'hub-child',
      setup: { policy: 'skip' },
      lineage: { parentConversationId: parentId },
      provenance: { surface: 'automation', machineId: 'local', requestedAt: Date.now() },
    }
  }

  private async diskCheck(plan: StoredPlan): Promise<{ problem: string | null; needBytes: number | null; freeBytes: number | null }> {
    const worktrees = plan.children.filter((c) => c.location === 'worktree')
    if (worktrees.length === 0) return { problem: null, needBytes: 0, freeBytes: null }
    const free = await this.io.freeBytes(plan.projectPath)
    let need = 0
    let known = true
    for (const c of worktrees) {
      const checkout = c.baseSha ? await this.io.checkoutBytes(plan.projectPath, c.baseSha) : null
      if (checkout === null) known = false
      need += checkout ?? 0
      if (c.deps === 'clone') {
        for (const dir of await this.io.dependencyDirs(plan.projectPath)) {
          const bytes = await this.io.dirBytes(join(plan.projectPath, dir))
          need += Math.round((bytes ?? 0) * CLONE_SHARE)
        }
      }
    }
    if (free === null) {
      log.warn('could not read free space; starting the batch without the free-space check')
      return { problem: null, needBytes: known ? need : null, freeBytes: null }
    }
    // An unsized checkout counts as nothing: the floor still holds for the part that is known.
    if (!known) log.warn('could not size every checkout of the batch; the free-space check uses the known part')
    const minFreeGiB = readHubSettings(this.getSetting).minFreeGiB
    return {
      problem: hubDiskProblem({ freeBytes: free, needBytes: need, minFreeGiB }),
      needBytes: known ? need : null,
      freeBytes: free,
    }
  }

  private writeStartedRow(parentId: string, batchId: string, text: string): void {
    const messageId = `hub_${batchId}`
    const content = formatApprovalResultMarker({
      requestId: batchId,
      title: 'Start child chats',
      outcome: 'done',
      text,
      delivery: 'none',
    })
    try {
      saveMessageIfAbsent(messageId, parentId, 'system', content)
      this.host.announceRow(parentId, { messageId, requestId: batchId, content })
    } catch (err) {
      log.warn(`could not store the started row of batch ${batchId}`, err)
    }
  }
}

function openCapProblem(parentId: string, adding: number): string | null {
  const open = listHubChildren(parentId).filter((c) => isOpenChildPhase(c.phase)).length
  if (open + adding <= HUB_OPEN_CHILDREN_MAX) return null
  return `This chat has ${open} open children; at most ${HUB_OPEN_CHILDREN_MAX} may be open at once. Settle some first.`
}

function planDigest(parentId: string, plan: StoredPlan): string {
  // Child ids are fresh on every call, so they are left out: the same tasks give the same digest.
  const tasks = plan.children.map(({ childId: _id, ...rest }) => rest)
  return createHash('sha256').update(JSON.stringify([parentId, plan.projectPath, tasks])).digest('hex')
}

const dirBytesCache = new Map<string, { bytes: number | null; at: number }>()

function defaultIo(): HubStartIo {
  const git = async (cwd: string, args: string[]) =>
    (await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout
  return {
    async freeBytes(path) {
      try {
        const s = await statfs(path)
        return s.bavail * s.bsize
      } catch (err) {
        log.warn(`could not read free space at ${path}`, err)
        return null
      }
    },
    async checkoutBytes(projectPath, sha) {
      try {
        const out = await git(projectPath, ['ls-tree', '-r', '-l', sha])
        let total = 0
        for (const line of out.split('\n')) {
          const size = Number(line.split(/\s+/)[3])
          if (Number.isFinite(size)) total += size
        }
        return total
      } catch (err) {
        log.warn(`could not size the checkout at ${sha}`, err)
        return null
      }
    },
    async dirBytes(path) {
      const cached = dirBytesCache.get(path)
      if (cached && Date.now() - cached.at < DIR_BYTES_TTL_MS) return cached.bytes
      let bytes: number | null = null
      try {
        const out = (await execFileP('du', ['-sk', path], { maxBuffer: 1024 * 1024 })).stdout
        const kb = Number(out.trim().split(/\s+/)[0])
        bytes = Number.isFinite(kb) ? kb * 1024 : null
      } catch (err) {
        log.warn(`could not measure ${path}`, err)
      }
      dirBytesCache.set(path, { bytes, at: Date.now() })
      return bytes
    },
    dependencyDirs: (projectPath) => findDependencyDirs(projectPath),
    cloneDependencyDir: (projectPath, worktreePath, dir) =>
      // The child's setting decided already; the worktree clone switch is for background clones.
      cloneDependencyDirs(projectPath, worktreePath, { dir, isEnabled: () => true }),
    async isMainCheckout(cwd) {
      try {
        const [gitDir, common] = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']))
          .trim()
          .split('\n')
        return gitDir === common
      } catch (err) {
        log.warn(`could not tell whether ${cwd} is the main checkout`, err)
        return false
      }
    },
    async commitOf(cwd, ref) {
      try {
        return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null
      } catch (err) {
        log.debug(`${ref} is not a commit in ${cwd}`, err)
        return null
      }
    },
  }
}

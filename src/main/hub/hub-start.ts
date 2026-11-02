/**
 * Starting child chats: `start_children` proposes a batch, the batch card (or,
 * in auto-accept edits and above, nothing) approves it, and the runner starts
 * each child.
 *
 * Per child, in order: its `hub_children` row (phase `starting`); a worktree
 * through the worktree creation service (purpose `hub-child`, which skips the
 * background dependency clone), or the project folder for `location:
 * 'project'`; then its dependency folders linked, cloned or installed before
 * the first turn (`hub-deps.ts`); then the session with the brief as its first
 * turn, once a run slot is free. After each child turn the links are checked:
 * a child that changed shared dependencies is stopped with a `blocked` wake. One
 * child failing marks it `failed_start` with a `failed` wake, and the batch
 * goes on. A child never gets more access than its parent (`grantedMode`).
 *
 * A task may name another machine (`machine`, flag `hub_remote_children`, a
 * parent on the desktop only). `propose` checks it against the hub client's
 * description of that machine (`planRemoteTask`), resolves the base commit to
 * one a remote branch holds, checks that machine's disk, and always opens the
 * card. On approval the desktop sends each such child to its machine
 * (`hub-remote:start-child`, through `HubStartHost.startRemoteChild`, a few at
 * a time per machine) and records the machine (`hub_children.machine_id`) and
 * the mode used; nothing on this machine runs it. A refusal or an older
 * backend fails that child only. A call with no answer leaves it `starting`,
 * and `reconcileRemote` sends the same request again (at launch, on that
 * machine's connect, and a few times after a `starting` answer).
 *
 * On the child machine `startRemote` takes that request: it checks the flag,
 * the per-machine cap (`hub.remoteChildrenPerMachine`) and the account, lowers
 * the mode to `hub.remoteMaxMode`, makes a parent stub (`hub_parents.remote_hub`),
 * clones the project when one was planned, fetches the base from a configured
 * remote whose URL matches, and then runs the same pipeline as a local child
 * (`prepareChild`). It answers once the child started or failed, or after
 * `HUB_REMOTE_START_WAIT_MS` with `starting`. A repeated request for a child it
 * knows answers that child's state and starts nothing.
 *
 * Measured: one `hub.batch` and one `hub.start-child` perf line per batch and
 * child (outcome and the time of each step), `hub.child-turn` per child turn
 * end (machine id, tokens, cost, duration), the worktree's disk use after start,
 * `hub.deps-check` per child turn end of a child with links, and
 * `hub.own-deps` per `own_dependencies` call.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { stat, statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  HUB_MAIN_CHECKOUT_WARNING,
  HUB_OPEN_CHILDREN_MAX,
  HUB_REPORT_LINE,
  HUB_SETTINGS,
  grantedMode,
  hubBatchDetail,
  hubBriefTurn,
  hubDiskProblem,
  hubNeedsCard,
  isOpenChildPhase,
  readHubSettings,
  runSlotFree,
  type HubBatchMachine,
  type HubBatchView,
  type HubChildLocation,
  type HubRemoteDiskView,
  type HubDepsMode,
  type HubRunningChild,
  type HubTask,
  type HubWakeKind,
} from '@shared/hub'
import {
  HUB_REMOTE_OFF_TEXT,
  HUB_REMOTE_VM_PARENT_TEXT,
  expandHubPath,
  hubRemoteStartFailureText,
  hubRepoUrl,
  isNoHandlerError,
  parseGitRemoteFetchUrls,
  parseHubRemoteStartAnswer,
  parseHubRemoteStartRequest,
  parseRemoteBranches,
  pickFetchBranch,
  planRemoteTask,
  remoteApprovalProblem,
  remoteMachineId,
  remoteUrlKey,
  type HubMachineEntry,
  type HubRemoteStartAnswer,
  type HubRemoteStartRequest,
} from '@shared/hub-remote'
import type { SettingReader } from '@shared/limit-resume'
import type { RuntimeMode, UserTurnSubmissionResult, UserTurnSubmissionV1 } from '@shared/provider-events'
import { defaultInstanceId, providerKindFor, type AgentProvider } from '@shared/types'
import {
  WORKTREE_CREATION_SCHEMA_VERSION,
  type WorktreeCreationRequest,
  type WorktreeCreationSnapshot,
} from '@shared/worktree-creation'
import { formatApprovalResultMarker } from '@shared/agent-approval-cards'
import type { WorktreeCreationRuntime } from '../worktree-creation/runtime'
import {
  claimHubParentStub,
  countOpenRemoteHubChildren,
  createConversation,
  createHubBatch,
  ensureHubParent,
  getHubParent,
  hubInstallId,
  lastHubWakeOf,
  lastMessageAt,
  listOpenRemoteHubChildren,
  findProposedHubBatch,
  getHubBatch,
  getConversationById,
  getHubChild,
  insertHubChild,
  insertHubWake,
  newHubRowId,
  listHubChildren,
  listHubChildrenInPhase,
  openChildParentId,
  otherWorktreeUsers,
  resolveRootThreadId,
  saveMessageIfAbsent,
  setConversationProviderInstanceId,
  setConversationRuntimeMode,
  setHubBatchStatus,
  threadFamilyIds,
  updateHubChild,
  type HubChildRow,
} from '../db/database'
import { resolveProviderInstance } from '../db/provider-instances'
import type { SessionStartOpts } from '../provider/types'
import {
  checkChildDeps,
  depsBriefLine,
  depsSummary,
  linkedFolders,
  ownChildDeps,
  parseChildDeps,
  planChildDeps,
  prepareChildDeps,
  trackDependencyLinks,
  untrackDependencyLinks,
  type ChildDepsState,
  type DepsFolderPlan,
} from './hub-deps'
import { toolText, type McpToolResult } from '../mcp/mcp-session'
import { asThisMachine } from '../backend/request-context'
import { removeDependencyLinks } from '../git/dependency-links'
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
  /** The heaviest mode of `depsPlan`, for the card. */
  deps: HubDepsMode
  /** Per folder, as planned for the card and the disk check; the start plans again. Empty on another machine. */
  depsPlan: DepsFolderPlan[]
  /** The machine it runs on; null, or absent in a plan stored before, for this one. */
  machine?: HubBatchMachine | null
  /** Another machine: the checkout there its worktree comes from, `~/...` as that machine names it. */
  remoteProjectPath?: string | null
  /** Another machine: no checkout of the project there, so one is cloned into `remoteProjectPath`. */
  clonePlanned?: boolean
  /** Another machine: the remote branch that machine fetches `baseSha` from. */
  fetch?: { remoteBranch: string } | null
  /**
   * Another machine: the URL (no credentials) of the remote `fetch` names and
   * the branch there, read in the checkout that picked the branch. Absent in a
   * plan stored before: the start reads it again in the project folder.
   */
  repo?: { url: string; branch: string } | null
  /** Another machine: the dependency setting the card showed, sent as is. Absent in a plan stored before. */
  depsSetting?: HubDepsMode
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

/** The backend's worktree creation service: children's worktrees are made and removed through it. */
export type HubWorktreeService = Pick<
  WorktreeCreationRuntime,
  'createWorktreeTransaction' | 'getWorktreeCreation' | 'actOnWorktreeCreation'
>

let worktreeService: HubWorktreeService | null = null

/** Set once the service exists (`createDefaultWorktreeCreationRuntime`). */
export function configureHubWorktrees(service: HubWorktreeService): void {
  worktreeService = service
}

export function hubWorktrees(): HubWorktreeService | null {
  return worktreeService
}

export function hubWorktreeCreator(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot> {
  if (!worktreeService) return Promise.reject(new Error('The worktree creation service is not ready.'))
  return worktreeService.createWorktreeTransaction(request)
}

/**
 * Removes a child's worktree, and the branch its creation made (never one that
 * was there before), through the worktree service. Null when the worktree is
 * gone; else why it stays. For a child of a parent stub the removal is this
 * machine's own (`asThisMachine`): the hub on the other machine started the
 * child, and the creation is the one this machine made for this child row. A
 * local child keeps the caller's scopes.
 */
export async function removeChildWorktree(child: HubChildRow): Promise<string | null> {
  const service = worktreeService
  if (!service) return 'the worktree service is not ready'
  const worktree = getConversationById(child.childId)?.worktree_path
  const key = { machineId: 'local', creationId: child.creationId ?? `${child.batchId}-${child.ordinal}` }
  try {
    // A chat may have opened the worktree since the plan read it.
    if (worktree && otherWorktreeUsers(worktree, child.childId) > 0) return 'another chat or card works in it'
    const ownedByChild = (snapshot: WorktreeCreationSnapshot) =>
      snapshot.owner.kind === 'conversation' && snapshot.owner.conversationId === child.childId
    if (!ownedByChild(await service.getWorktreeCreation(key))) return 'the worktree was not made for this child'
    if (worktree) await removeDependencyLinks(worktree)
    // Read again after the unlink: the removal acts on this revision, and its owner is checked on it.
    const current = await service.getWorktreeCreation(key)
    if (!ownedByChild(current)) return 'the worktree was not made for this child'
    const remove = () => service.actOnWorktreeCreation({ ...key, expectedRevision: current.revision, action: 'remove' })
    const done = await (getHubParent(child.parentId)?.remoteHub ? asThisMachine(remove) : remove())
    if (done.cleanupDisposition === 'removed') return null
    return done.error?.message ?? 'git refused to remove it'
  } catch (err) {
    log.warn(`could not remove the worktree of child ${child.childId}`, err)
    return err instanceof Error ? err.message : String(err)
  }
}

export interface HubStartHost {
  createWorktree(request: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
  startSession(opts: SessionStartOpts): Promise<unknown>
  submitTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult>
  /** Opens the batch card on the parent; the approval comes back through `approve`. */
  openCard(input: {
    threadId: string
    parentId: string
    detail: string
    plan: HubBatchPlan
  }): { ok: true; requestId: string } | { ok: false; message: string }
  /** A new system row in the parent's chat, for clients to show. */
  announceRow(parentId: string, row: { messageId: string; requestId: string; content: string }): void
  /** Stops a child's session, as the user's Stop does. */
  stopChild(childId: string): Promise<void>
  /** A child of `parentId` was added, changed phase or got a wake: clients read the parent's view again. */
  changed?(parentId: string): void
  /** Whether a task may name another machine: `hub_remote_children`, and whether this backend runs on a VM. Absent: off. */
  remoteChildren?(): { flagOn: boolean; onVm: boolean }
  /** Every other machine as the hub client knows it, descriptions read again when older than 60 s. */
  machineEntries?(): Promise<HubMachineEntry[]>
  /** Calls `hub-remote:start-child` on another machine; resolves with its raw answer. Absent: no hub client. */
  startRemoteChild?(machineId: string, request: HubRemoteStartRequest): Promise<unknown>
  /** Whether a saved machine is connected now, or was removed. Absent: every machine counts as connected. */
  remoteMachineState?(machineId: string): 'connected' | 'offline' | 'gone'
  /** A Stop of this child waits to be sent or answered on its machine: its start is not sent meanwhile. */
  remoteStopping?(childId: string): boolean
  /** A wake for a parent stub went into the outbox: tell the hub that owns it. */
  outboxAdded?(): void
}

/** Git and disk reads, replaceable in tests. */
export interface HubStartIo {
  freeBytes(path: string): Promise<number | null>
  /** Bytes of the tracked files at `sha`: what a worktree checkout writes. */
  checkoutBytes(projectPath: string, sha: string): Promise<number | null>
  dirBytes(path: string): Promise<number | null>
  planDeps(projectPath: string, baseSha: string, setting: HubDepsMode): Promise<DepsFolderPlan[]>
  prepareDeps(projectPath: string, worktreePath: string, plans: DepsFolderPlan[]): Promise<ChildDepsState>
  checkDeps(worktreePath: string, state: ChildDepsState): Promise<string[]>
  ownDeps(
    projectPath: string,
    worktreePath: string,
    state: ChildDepsState,
  ): Promise<{ state: ChildDepsState; lines: string[] }>
  isMainCheckout(cwd: string): Promise<boolean>
  commitOf(cwd: string, ref: string): Promise<string | null>
  /** Fetch URLs of the checkout's git remotes. */
  remoteUrls(cwd: string): Promise<string[]>
  /** Remote branches (`origin/main`) that contain `sha`. */
  remoteBranchesContaining(cwd: string, sha: string): Promise<string[]>
  /** The checkout's upstream branch (`origin/main`), or null. */
  upstreamOf(cwd: string): Promise<string | null>
  /** The remote a remote branch (`fork/main`) lives on: its configured URL and the branch name there. */
  remoteOfBranch(cwd: string, remoteBranch: string): Promise<{ url: string; branch: string } | null>
  /** The configured remotes (`remote.<name>.url`, as written), in config order. */
  configuredRemotes(cwd: string): Promise<Array<{ name: string; url: string }>>
  homeDir(): string
  isDir(path: string): Promise<boolean>
  /** Clones `url` at `branch` into `dest` with this machine's git; throws with git's last line on failure. */
  clone(url: string, branch: string, dest: string): Promise<void>
  /**
   * Fetches `branch` from the configured `remote` into a scratch ref and checks
   * that `sha` is in it; throws when the fetch fails or the commit is not there.
   */
  fetchBase(cwd: string, remote: string, branch: string, sha: string): Promise<void>
}

/** How long `hub-remote:start-child` waits for the child's first turn before it answers `starting`. */
export const HUB_REMOTE_START_WAIT_MS = 12_000
/** Remote children of one batch started at once on one machine. */
const REMOTE_STARTS_PER_MACHINE = 2
/** A remote start with no final answer is asked again this often, this many times; then on the next connect. */
export const HUB_REMOTE_FOLLOW_UP_MS = 15_000
const REMOTE_FOLLOW_UPS = 8

/** A clone costs about this share of the folder (copy-on-write metadata). */
const CLONE_SHARE = 0.05
const DIR_BYTES_TTL_MS = 10 * 60_000
/** A fetch of a child's base on its machine: no prompt can answer it, so it ends. */
const FETCH_TIMEOUT_MS = 5 * 60_000

export class HubStarter {
  private readonly io: HubStartIo
  private readonly running = new Map<string, HubRunningChild>()
  private readonly waiting: Array<{ childId: string; slot: HubRunningChild; go: () => void }> = []
  private readonly lastTurn = new Map<string, { usedTokens?: number; costUsd?: number; at: number }>()
  private readonly diskUse = new Map<string, number>()
  /** Children this process launched, to their parents. A restart forgets them; restart recovery comes later. */
  private readonly launched = new Map<string, string>()
  /** Children stopped before their first turn: the launch ends them. */
  private readonly cancelled = new Set<string>()
  /** Open children with linked dependency folders, for the post-turn check. Rebuilt at startup. */
  private readonly linked = new Map<string, { worktree: string; parentId: string; state: ChildDepsState }>()
  /** The checkout step of remote starts, per project folder on this machine. */
  private readonly checkouts = new Map<string, Promise<void>>()
  /** Remote children whose start request is in flight from here. */
  private readonly remoteCalls = new Set<string>()
  /** Remote children still `starting` that are asked again: tries so far and the timer. */
  private readonly followUps = new Map<string, { tries: number; timer: ReturnType<typeof setTimeout> | null }>()
  private readonly followUpMs: number
  private disposed = false

  constructor(
    private readonly host: HubStartHost,
    private readonly getSetting: SettingReader,
    io: Partial<HubStartIo> = {},
    opts: { followUpMs?: number } = {},
  ) {
    this.io = { ...defaultIo(), ...io }
    this.followUpMs = opts.followUpMs ?? HUB_REMOTE_FOLLOW_UP_MS
  }

  /**
   * Children left in `starting` by a quit never got their first turn. They
   * are marked failed with a wake; the worktree creation service finishes or
   * rolls back their worktrees on its own. An open child of a parent stub
   * (a hub on another machine) lost its session with this backend: its parent
   * hears of it with a `restart` wake through the outbox, unless its newest
   * wake is one and no message reached it since.
   */
  recoverInterrupted(): void {
    for (const child of listHubChildrenInPhase('starting')) {
      updateHubChild(child.childId, { phase: 'failed_start' })
      this.failedWake(child.parentId, child.childId, 'Start was cut off when Switchboard quit.')
      log.info('child start cut off by a quit', { childId: child.childId, parentId: child.parentId })
      this.dropRemoteStartWorktree(child.parentId, child.childId)
    }
    for (const child of listHubChildrenInPhase('open')) {
      const state = parseChildDeps(child.depsJson)
      const conv = getConversationById(child.childId)
      if (linkedFolders(state).length > 0 && conv?.worktree_path)
        this.track(child.childId, child.parentId, conv.worktree_path, state)
      if (getHubParent(child.parentId)?.remoteHub && !this.toldOfRestart(child.childId)) {
        this.wake({
          parentId: child.parentId,
          childId: child.childId,
          kind: 'restart',
          summary: 'The backend on its machine restarted, so its session ended.',
          pointer: null,
        })
        log.info('child session ended by a backend restart', { childId: child.childId, parentId: child.parentId })
      }
    }
  }

  private toldOfRestart(childId: string): boolean {
    const last = lastHubWakeOf(childId)
    return last?.kind === 'restart' && (lastMessageAt(threadFamilyIds(childId)) ?? 0) <= last.createdAt
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

  /** The run-slot key of each child with a turn in flight now. */
  runningSlotKeys(): string[] {
    return [...this.running.values()].map((r) => r.providerInstanceId)
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

    const remoteTask = tasks.findIndex((t) => remoteMachineId(t.machine) !== null)
    if (remoteTask >= 0) {
      const gate = this.host.remoteChildren?.() ?? { flagOn: false, onVm: false }
      const refusal = !gate.flagOn ? HUB_REMOTE_OFF_TEXT : gate.onVm ? HUB_REMOTE_VM_PARENT_TEXT : null
      if (refusal) return toolText(`Task ${remoteTask + 1}: ${refusal}`, true)
    }
    const remote = remoteTask >= 0 ? await this.remoteFacts(ctx) : null

    const settings = readHubSettings(this.getSetting)
    const head = await this.io.commitOf(ctx.cwd, 'HEAD')
    const depsPlans = new Map<string, Promise<DepsFolderPlan[]>>()
    const planDeps = (sha: string) => {
      if (!depsPlans.has(sha)) {
        const span = perfSpan('hub.deps-plan', { parentId: ctx.parentId })
        const plan = this.io.planDeps(ctx.projectPath, sha, settings.childDependencies)
        plan.then(
          (plans) => span.end({ outcome: 'ok', folders: plans.length }),
          () => span.end({ outcome: 'error' }),
        )
        depsPlans.set(sha, plan)
      }
      return depsPlans.get(sha)!
    }
    const children: PlannedChild[] = []
    for (const [i, task] of tasks.entries()) {
      const agent = task.agent ?? ctx.agent
      const machineId = remoteMachineId(task.machine)
      if (machineId !== null && remote) {
        const planned = await this.planRemoteChild(ctx, i, task, agent, machineId, head, remote)
        if (!planned.ok) return toolText(planned.message, true)
        children.push(planned.child)
        continue
      }
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
      const depsPlan = baseSha ? await planDeps(baseSha) : []
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
        deps: depsSummary(depsPlan.map((p) => p.mode)),
        depsPlan,
        machine: null,
      })
    }

    const plan: StoredPlan = { projectPath: ctx.projectPath, children }
    const disk = await this.diskCheck(plan)
    if (disk.problem) return toolText(disk.problem, true)
    const remoteDisk = remote ? await this.remoteDiskCheck(plan, remote.entries) : null
    if (remoteDisk?.problem) return toolText(remoteDisk.problem, true)
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
        machine: c.machine ?? null,
        ...(c.machine ? { clone: c.clonePlanned === true, remoteProjectPath: c.remoteProjectPath ?? '' } : {}),
      })),
      needBytes: disk.needBytes,
      freeBytes: disk.freeBytes,
      ...(remoteDisk ? { remoteDisk: remoteDisk.lines } : {}),
      mainCheckout: await this.io.isMainCheckout(ctx.cwd),
    }

    // After the last await, so two identical calls in flight cannot both open a card.
    const digest = planDigest(ctx.parentId, plan)
    const same = findProposedHubBatch(ctx.parentId, digest)
    if (same?.cardRequestId)
      return toolText(`This batch already waits for the user (card ${same.cardRequestId}). Do not send it again.`)

    if (hubNeedsCard(ctx.mode, remote !== null)) {
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
    createHubBatch({
      batchId,
      parentId: ctx.parentId,
      cardRequestId: null,
      planJson: JSON.stringify(plan),
      planDigest: digest,
    })
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
    const remoteProblems = await this.remoteApprovalProblems(plan)
    // After the last await, so a batch started meanwhile counts.
    const problem = disk.problem ?? openCapProblem(batch.parentId, plan.children.length)
    if (problem) {
      setHubBatchStatus(batchId, 'denied')
      return toolText(`${problem} No children were started.`, true)
    }
    return toolText(this.startApproved(batchId, parentMode, false, remoteProblems))
  }

  /**
   * Per child on another machine, why it cannot start: its machine is no
   * longer connected, lost the capability or the account. A failed machine
   * fails only its own children.
   */
  private async remoteApprovalProblems(plan: StoredPlan): Promise<Map<string, string>> {
    const problems = new Map<string, string>()
    const remote = plan.children.filter((c) => c.machine)
    if (remote.length === 0) return problems
    let entries: HubMachineEntry[] = []
    try {
      entries = (await this.host.machineEntries?.()) ?? []
    } catch (err) {
      log.warn('could not read the machines at approval', err)
    }
    for (const c of remote) {
      const problem = remoteApprovalProblem({
        machineId: c.machine!.id,
        agent: c.agent,
        instanceId: c.instanceId,
        entries,
      })
      if (problem) problems.set(c.childId, problem)
    }
    return problems
  }

  /** What every task on another machine needs: the machines, and the parent checkout's remotes and upstream. */
  private async remoteFacts(ctx: HubParentContext): Promise<RemoteFacts> {
    const [entries, remoteUrls, upstream] = await Promise.all([
      (this.host.machineEntries?.() ?? Promise.resolve([])).catch((err: unknown) => {
        log.warn('could not read the machines for start_children', err)
        return [] as HubMachineEntry[]
      }),
      this.io.remoteUrls(ctx.cwd),
      this.io.upstreamOf(ctx.cwd),
    ])
    return { entries, remoteUrls, upstream }
  }

  /** One task on another machine: the machine's checks, then a base commit a remote branch holds. */
  private async planRemoteChild(
    ctx: HubParentContext,
    i: number,
    task: HubTask,
    agent: AgentProvider,
    machineId: string,
    head: string | null,
    remote: RemoteFacts,
  ): Promise<{ ok: true; child: PlannedChild } | { ok: false; message: string }> {
    const n = i + 1
    const checked = planRemoteTask({
      n,
      machineId,
      agent,
      account: task.account,
      model: task.model,
      location: task.location,
      entries: remote.entries,
      parentRemoteUrls: remote.remoteUrls,
    })
    if (!checked.ok) return checked
    const baseSha = task.baseRef ? await this.io.commitOf(ctx.cwd, task.baseRef) : head
    if (!baseSha)
      return {
        ok: false,
        message: task.baseRef
          ? `Task ${n}: base ${task.baseRef} is not a commit here. Fetch it first, or name another.`
          : `Task ${n}: this chat's folder is not a git checkout, so ${checked.plan.machine.name} cannot get it.`,
      }
    const remoteBranch = pickFetchBranch(await this.io.remoteBranchesContaining(ctx.cwd, baseSha), remote.upstream)
    if (!remoteBranch)
      return { ok: false, message: `Task ${n}: commit ${baseSha.slice(0, 7)} is not on any remote. Push it first.` }
    // Read in the checkout that picked the branch: a linked worktree can configure its own remotes.
    const source = await this.io.remoteOfBranch(ctx.cwd, remoteBranch)
    const url = source ? hubRepoUrl(source.url) : null
    if (!source || !url)
      return {
        ok: false,
        message: `Task ${n}: the remote of ${remoteBranch} cannot be fetched from ${checked.plan.machine.name}.`,
      }
    const depsSetting = readHubSettings(this.getSetting).childDependencies
    return {
      ok: true,
      child: {
        childId: `agent_${Date.now()}_${randomBytes(4).toString('hex')}`,
        ordinal: i,
        title: task.title,
        brief: task.brief,
        location: 'worktree',
        baseRef: task.baseRef ?? 'HEAD',
        baseSha,
        branchSeed: task.branch ?? task.title,
        agent,
        instanceId: checked.plan.instanceId,
        model: task.model ?? null,
        requestedMode: task.mode ?? null,
        shownMode: grantedMode(task.mode, ctx.mode),
        deps: depsSetting,
        depsPlan: [],
        machine: checked.plan.machine,
        remoteProjectPath: checked.plan.remoteProjectPath,
        clonePlanned: checked.plan.clonePlanned,
        fetch: { remoteBranch },
        repo: { url, branch: source.branch },
        depsSetting,
      },
    }
  }

  /**
   * Disk on each other machine: the tracked files of each child's base
   * commit, plus one more checkout where a clone is planned, against the free
   * space and floor that machine described. Dependencies there are planned by
   * that machine at start, so they are not counted here.
   */
  private async remoteDiskCheck(
    plan: StoredPlan,
    entries: readonly HubMachineEntry[],
  ): Promise<{ problem: string | null; lines: HubRemoteDiskView[] }> {
    const byMachine = new Map<string, PlannedChild[]>()
    for (const c of plan.children) {
      if (c.machine) byMachine.set(c.machine.id, [...(byMachine.get(c.machine.id) ?? []), c])
    }
    const lines: HubRemoteDiskView[] = []
    for (const [machineId, children] of byMachine) {
      const machine = children[0]!.machine!
      const description = entries.find((e) => e.id === machineId)?.description ?? null
      let need = 0
      let known = true
      let cloneCounted = false
      for (const c of children) {
        const bytes = c.baseSha ? await this.io.checkoutBytes(plan.projectPath, c.baseSha) : null
        if (bytes === null) known = false
        need += bytes ?? 0
        // The clone's own checkout, once per machine.
        if (c.clonePlanned && !cloneCounted) {
          need += bytes ?? 0
          cloneCounted = true
        }
      }
      const freeBytes = description?.freeDiskBytes ?? null
      lines.push({ machineId, name: machine.name, needBytes: known ? need : null, freeBytes })
      if (freeBytes === null) continue
      const minFreeGiB = description?.minFreeGiB ?? HUB_SETTINGS.minFreeGiB.defaultValue
      const problem = hubDiskProblem({ freeBytes, needBytes: need, minFreeGiB })
      if (problem) return { problem: `On ${machine.name}: ${problem}`, lines }
    }
    return { problem: null, lines }
  }

  /** The card closed without an approval. */
  closed(batchId: string, how: 'denied' | 'withdrawn'): void {
    if (getHubBatch(batchId)?.status === 'proposed') setHubBatchStatus(batchId, how)
  }

  /** A turn of some chat ended: frees its run slot and records a child's tokens. */
  onTurnEnded(threadId: string, turn?: { usedTokens?: number; costUsd?: number; durationMs?: number }): void {
    // No database read on this hot path while no child started in this process.
    if (this.launched.size === 0 && this.linked.size === 0) return
    const childId = resolveRootThreadId(threadId)
    if (this.linked.has(childId)) void this.checkLinks(childId)
    const slot = this.running.get(childId)
    if (slot) this.running.delete(childId)
    if (turn) {
      const parentId = this.launched.get(childId)
      if (parentId) {
        this.lastTurn.set(childId, { usedTokens: turn.usedTokens, costUsd: turn.costUsd, at: Date.now() })
        perfSpan('hub.child-turn', {
          childId,
          parentId,
          machineId: getHubChild(childId)?.machineId ?? 'local',
          usedTokens: turn.usedTokens,
          costUsd: turn.costUsd,
          turnMs: turn.durationMs,
        }).end()
      }
    }
    if (slot) this.pump()
  }

  private startApproved(
    batchId: string,
    parentMode: RuntimeMode,
    mainCheckout: boolean,
    remoteProblems: ReadonlyMap<string, string> = new Map(),
  ): string {
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
        machineId: c.machine?.id ?? null,
      })
    }
    this.host.changed?.(batch.parentId)
    void this.runBatch(batchId, batch.parentId, plan, remoteProblems).catch((err) =>
      log.error(`batch ${batchId} failed`, err),
    )
    const lines = plan.children.map((c) => {
      if (!c.machine) return `- ${c.title}: ${c.childId}`
      const problem = remoteProblems.get(c.childId)
      return `- ${c.title}: ${c.childId} on ${c.machine.name}${problem ? `: ${problem}` : ''}`
    })
    return [
      `Starting ${plan.children.length} child chat${plan.children.length === 1 ? '' : 's'}. Each starts in its own ` +
        'worktree (or the project folder) and gets its brief as its first turn:',
      ...lines,
      ...(mainCheckout
        ? [HUB_MAIN_CHECKOUT_WARNING, 'Ask the user before you merge into a branch checked out there.']
        : []),
    ].join('\n')
  }

  private async runBatch(
    batchId: string,
    parentId: string,
    plan: StoredPlan,
    remoteProblems: ReadonlyMap<string, string>,
  ): Promise<void> {
    const span = perfSpan('hub.batch', { batchId, parentId, children: plan.children.length })
    // Children on other machines start there, next to the local ones.
    const remote = this.startRemoteChildren(
      parentId,
      plan,
      plan.children.filter((c) => c.machine),
      remoteProblems,
    )
    let failed = 0
    for (const c of plan.children) {
      if (c.machine) continue
      // Worktrees and clones go one at a time; the agents start as run slots free.
      if (!(await this.prepareChild(batchId, parentId, plan.projectPath, c))) failed++
    }
    failed += await remote
    span.end({ failed })
  }

  /**
   * Sends each child on another machine to that machine, at most
   * `REMOTE_STARTS_PER_MACHINE` at once per machine. Returns how many failed.
   */
  private async startRemoteChildren(
    parentId: string,
    plan: StoredPlan,
    children: readonly PlannedChild[],
    problems: ReadonlyMap<string, string>,
  ): Promise<number> {
    const byMachine = new Map<string, PlannedChild[]>()
    for (const c of children) byMachine.set(c.machine!.id, [...(byMachine.get(c.machine!.id) ?? []), c])
    let failed = 0
    const one = async (c: PlannedChild) => {
      try {
        if (!(await this.startOnMachine(parentId, plan, c, problems.get(c.childId) ?? null))) failed++
      } catch (err) {
        // One child's throw must not end its lane: the rest of the queue still starts.
        failed++
        try {
          this.fail(parentId, c, err)
        } catch (failErr) {
          log.error(`could not fail the remote start of ${c.childId}`, failErr)
        }
      }
    }
    await Promise.all(
      [...byMachine.values()].map(async (queue) => {
        const lanes = Array.from({ length: Math.min(REMOTE_STARTS_PER_MACHINE, queue.length) }, async () => {
          for (let c = queue.shift(); c; c = queue.shift()) await one(c)
        })
        await Promise.all(lanes)
      }),
    )
    return failed
  }

  /** One child on another machine: the start request, and its answer on the desktop row. False when it failed. */
  private async startOnMachine(
    parentId: string,
    plan: StoredPlan,
    c: PlannedChild,
    problem: string | null,
  ): Promise<boolean> {
    const machine = c.machine!
    const span = perfSpan('hub.remote-start', {
      childId: c.childId,
      machineId: machine.id,
      transport: machine.transport,
    })
    const failWith = (text: string, step: string) => {
      span.end({ outcome: 'failed', step })
      this.fail(parentId, c, new Error(text))
      return false
    }
    if (problem) return failWith(problem, 'approval')
    if (!this.host.startRemoteChild) return failWith(`${machine.name} cannot be reached from this backend.`, 'client')
    const built = await this.remoteRequest(parentId, plan, c)
    if (!built.ok) return failWith(built.message, built.step)
    const outcome = await this.sendRemoteStart(parentId, c, built.request)
    span.end({ outcome })
    return outcome !== 'failed'
  }

  /** The start request of a planned remote child, from its stored plan and its desktop row. */
  private async remoteRequest(
    parentId: string,
    plan: StoredPlan,
    c: PlannedChild,
  ): Promise<{ ok: true; request: HubRemoteStartRequest } | { ok: false; message: string; step: string }> {
    const row = getHubChild(c.childId)
    if (!row || !c.baseSha || !c.instanceId || !c.fetch || !c.remoteProjectPath)
      return { ok: false, message: 'its plan is incomplete.', step: 'plan' }
    // A plan stored before `repo` reads the remote again in the project folder.
    const source = c.repo ?? (await this.io.remoteOfBranch(plan.projectPath, c.fetch.remoteBranch))
    const repoUrl = source ? hubRepoUrl(source.url) : null
    if (!source || !repoUrl)
      return {
        ok: false,
        message: `the remote of ${c.fetch.remoteBranch} cannot be fetched from ${c.machine!.name}.`,
        step: 'remote',
      }
    return {
      ok: true,
      request: {
        v: 1,
        desktopInstallId: hubInstallId(),
        parentId,
        childId: c.childId,
        title: c.title,
        brief: c.brief,
        agent: c.agent,
        instanceId: c.instanceId,
        model: c.model,
        grantedMode: row.grantedMode,
        baseSha: c.baseSha,
        fetch: { remoteBranch: source.branch },
        repoUrl,
        remoteProjectPath: c.remoteProjectPath,
        clonePlanned: c.clonePlanned === true,
        deps: c.depsSetting ?? readHubSettings(this.getSetting).childDependencies,
        // `branchSeed` is the task's branch when it named one.
        branch: c.branchSeed !== c.title ? c.branchSeed : null,
      },
    }
  }

  /**
   * Sends the start request and applies its answer while the desktop row is
   * still `starting`. A call with no answer (a timeout, a closed client)
   * leaves the row `starting`: that machine may have started the child, and
   * the request is idempotent, so it is asked again (`followUp`, and on the
   * machine's next connect). Only an answer, or a backend without the
   * channel, ends the start.
   */
  private async sendRemoteStart(
    parentId: string,
    c: PlannedChild,
    request: HubRemoteStartRequest,
  ): Promise<'open' | 'starting' | 'failed' | 'unknown' | 'superseded'> {
    const machine = c.machine!
    // A Stop meanwhile: the start must not reach that machine after it.
    if (getHubChild(c.childId)?.phase !== 'starting' || this.host.remoteStopping?.(c.childId)) {
      this.endFollowUp(c.childId)
      return 'superseded'
    }
    this.remoteCalls.add(c.childId)
    let raw: unknown
    try {
      raw = await this.host.startRemoteChild!(machine.id, request)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isNoHandlerError(message)) return this.failRemote(parentId, c, `update the backend on ${machine.name}.`)
      log.info('no answer to a remote start; it stays starting', { childId: c.childId, machineId: machine.id, message })
      this.followUp(c.childId)
      return 'unknown'
    } finally {
      this.remoteCalls.delete(c.childId)
    }
    const answer = parseHubRemoteStartAnswer(raw)
    // A stop or a settle meanwhile leaves the row where it is.
    if (getHubChild(c.childId)?.phase !== 'starting') {
      this.endFollowUp(c.childId)
      return 'superseded'
    }
    if (!answer) return this.failRemote(parentId, c, `update the backend on ${machine.name}.`)
    if (!answer.ok) return this.failRemote(parentId, c, hubRemoteStartFailureText(machine.name, answer))
    // That machine only lowers the mode; an answer above the granted one is recorded as granted.
    const mode = grantedMode(answer.mode, request.grantedMode)
    updateHubChild(c.childId, { phase: answer.phase, grantedMode: mode })
    log.info('child started on another machine', { childId: c.childId, machineId: machine.id, phase: answer.phase })
    if (answer.phase === 'starting') this.followUp(c.childId)
    else this.endFollowUp(c.childId)
    this.host.changed?.(parentId)
    return answer.phase
  }

  private failRemote(parentId: string, c: PlannedChild, text: string): 'failed' {
    this.endFollowUp(c.childId)
    this.fail(parentId, c, new Error(text))
    return 'failed'
  }

  /** Asks again in `followUpMs`, at most `REMOTE_FOLLOW_UPS` times in a row; after that, on the next connect. */
  private followUp(childId: string): void {
    if (this.disposed) return
    const prev = this.followUps.get(childId)
    if (prev?.timer) clearTimeout(prev.timer)
    const tries = (prev?.tries ?? 0) + 1
    if (tries > REMOTE_FOLLOW_UPS) {
      this.followUps.delete(childId)
      log.info('remote start still unknown; asked again on the next connect', { childId })
      return
    }
    const timer = setTimeout(() => {
      const entry = this.followUps.get(childId)
      if (entry) entry.timer = null
      void this.reconcileRemote({ childId })
    }, this.followUpMs)
    timer.unref?.()
    this.followUps.set(childId, { tries, timer })
  }

  private endFollowUp(childId: string): void {
    const entry = this.followUps.get(childId)
    if (entry?.timer) clearTimeout(entry.timer)
    this.followUps.delete(childId)
  }

  /** The registry stopped: no more follow-ups or reconciles from this starter. */
  dispose(): void {
    this.disposed = true
    for (const { timer } of this.followUps.values()) if (timer) clearTimeout(timer)
    this.followUps.clear()
  }

  /**
   * Desktop rows of children on other machines still `starting` (a quit, a
   * timeout or a `starting` answer left them so) send the same start request
   * again, rebuilt from the stored plan; that machine answers the child's
   * state or starts it. Run at startup, on a machine's connect and by
   * `followUp`. A machine that is not connected waits for its connect; a
   * removed one fails its rows. Nothing is sent with `hub_remote_children` off.
   */
  async reconcileRemote(only: { machineId?: string; childId?: string } = {}): Promise<void> {
    if (this.disposed || !this.host.remoteChildren?.().flagOn) return
    let rows: HubChildRow[]
    try {
      rows = listHubChildrenInPhase('starting', { includeRemote: true }).filter(
        (c) =>
          c.machineId !== null &&
          (!only.machineId || c.machineId === only.machineId) &&
          (!only.childId || c.childId === only.childId),
      )
    } catch (err) {
      log.warn('could not read the remote children still starting', err)
      return
    }
    await Promise.all(rows.map((row) => this.reconcileOne(row)))
  }

  /**
   * A child on another machine wrote a failed or stopped wake at its start
   * there (the desktop imports it): the row here ends `failed_start` as a
   * local child's would, with no wake of its own. Runs inside the import's
   * transaction; the answer is what to do once it committed, or null when the
   * row was not starting or open.
   */
  remoteChildFailedStart(childId: string): (() => void) | null {
    const row = getHubChild(childId)
    if (!row?.machineId || (row.phase !== 'starting' && row.phase !== 'open')) return null
    updateHubChild(childId, { phase: 'failed_start' })
    return () => {
      this.endFollowUp(childId)
      log.info('child on another machine failed to start', { childId, machineId: row.machineId })
      // A remote child counts for its parent's slots while it is open: a waiter may go now.
      this.pump()
      this.host.changed?.(row.parentId)
    }
  }

  /** The machine was removed: its children still `starting` never get an answer. */
  remoteMachineRemoved(machineId: string): void {
    try {
      for (const row of listHubChildrenInPhase('starting', { includeRemote: true })) {
        if (row.machineId !== machineId) continue
        const name = this.storedChild(row)?.c.machine?.name ?? machineId
        this.endFollowUp(row.childId)
        this.fail(row.parentId, row, new Error(`${name} was removed before it answered the start.`))
      }
    } catch (err) {
      log.error(`could not fail the children of removed machine ${machineId}`, err)
    }
  }

  private async reconcileOne(row: HubChildRow): Promise<void> {
    if (this.remoteCalls.has(row.childId) || !this.host.startRemoteChild) return
    try {
      const stored = this.storedChild(row)
      if (!stored?.c.machine) {
        this.fail(row.parentId, row, new Error('its plan is gone.'))
        return
      }
      const { plan, c } = stored
      const state = this.host.remoteMachineState?.(row.machineId!) ?? 'connected'
      if (state === 'gone') {
        this.failRemote(row.parentId, c, `${c.machine!.name} was removed before it answered the start.`)
        return
      }
      if (state === 'offline') return
      const built = await this.remoteRequest(row.parentId, plan, c)
      if (!built.ok) {
        this.failRemote(row.parentId, c, built.message)
        return
      }
      await this.sendRemoteStart(row.parentId, c, built.request)
    } catch (err) {
      log.warn(`could not ask again about the remote start of ${row.childId}`, err)
    }
  }

  /** A desktop row's planned child, from its batch's stored plan. */
  private storedChild(row: HubChildRow): { plan: StoredPlan; c: PlannedChild } | null {
    const batch = getHubBatch(row.batchId)
    if (!batch) return null
    const plan = JSON.parse(batch.planJson) as StoredPlan
    const c = plan.children.find((x) => x.childId === row.childId)
    return c ? { plan, c } : null
  }

  /**
   * What `list_children` shows of a child on another machine that the desktop
   * has no conversation for: its agent and machine name from the plan.
   */
  remoteChildFacts(row: HubChildRow): { agent: AgentProvider; machine: string } | null {
    if (!row.machineId) return null
    try {
      const c = this.storedChild(row)?.c
      return c?.machine ? { agent: c.agent, machine: c.machine.name } : null
    } catch (err) {
      log.warn(`could not read the plan of remote child ${row.childId}`, err)
      return null
    }
  }

  /**
   * `hub-remote:start-child` on the child machine: a child of a parent on
   * another machine's hub. See the module header for the checks.
   */
  async startRemote(raw: unknown): Promise<HubRemoteStartAnswer> {
    const parsed = parseHubRemoteStartRequest(raw)
    if (!parsed.ok) return { ok: false, error: parsed.message }
    const r = parsed.request
    if (!this.host.remoteChildren?.().flagOn)
      return {
        ok: false,
        error: 'This machine does not take children: turn on hub_remote_children there.',
        refusal: { kind: 'flag_off' },
      }
    const existing = getHubChild(r.childId)
    if (existing) return this.knownRemoteChild(existing.childId, existing.parentId, r)
    const settings = readHubSettings(this.getSetting)
    const open = countOpenRemoteHubChildren()
    if (open >= settings.remoteChildrenPerMachine)
      return {
        ok: false,
        error: `This machine runs ${open} child${open === 1 ? '' : 'ren'} from other machines already (limit ${settings.remoteChildrenPerMachine}).`,
        refusal: { kind: 'cap', open, limit: settings.remoteChildrenPerMachine },
      }
    try {
      if (resolveProviderInstance(r.agent, r.instanceId)?.id !== r.instanceId)
        return { ok: false, error: `There is no account ${r.instanceId} here.` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    // A chat here, or a parent here, is never turned into a stub of another hub.
    if (getConversationById(r.parentId) || resolveRootThreadId(r.parentId) !== r.parentId)
      return { ok: false, error: 'That parent id names a chat on this machine.' }
    if (getConversationById(r.childId) || resolveRootThreadId(r.childId) !== r.childId)
      return { ok: false, error: 'That child id names a chat on this machine.' }
    const stub = getHubParent(r.parentId)
    if (stub && !stub.remoteHub) return { ok: false, error: 'That parent id names a chat on this machine.' }
    if (!claimHubParentStub(r.parentId, r.desktopInstallId))
      return { ok: false, error: 'That parent id belongs to another hub here.' }
    const mode = grantedMode(r.grantedMode, settings.remoteMaxMode)
    const batchId = `remote-${r.childId}`
    const c: PlannedChild = {
      childId: r.childId,
      ordinal: 0,
      title: r.title,
      brief: r.brief,
      location: 'worktree',
      baseRef: r.baseSha,
      baseSha: r.baseSha,
      branchSeed: r.branch ?? r.title,
      agent: r.agent,
      instanceId: r.instanceId,
      model: r.model,
      requestedMode: r.grantedMode,
      shownMode: mode,
      deps: r.deps,
      depsPlan: [],
      machine: null,
    }
    // Before the first await: a repeated request now finds the child.
    insertHubChild({
      childId: c.childId,
      parentId: r.parentId,
      batchId,
      ordinal: 0,
      title: c.title,
      brief: c.brief,
      location: 'worktree',
      grantedMode: mode,
      depsMode: r.deps,
      baseRef: r.baseSha,
      baseSha: r.baseSha,
      providerInstanceId: r.instanceId,
      requestedModel: r.model,
    })
    log.info('child from another machine', { childId: c.childId, parentId: r.parentId, mode })
    this.host.changed?.(r.parentId)
    const started = this.startForRemote(batchId, r, c)
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([started, new Promise<void>((go) => (timer = setTimeout(go, HUB_REMOTE_START_WAIT_MS)))])
    clearTimeout(timer)
    return this.knownRemoteChild(c.childId, r.parentId, r)
  }

  /** The answer for a child this machine already has: its state, nothing started. */
  private knownRemoteChild(childId: string, parentId: string, r: HubRemoteStartRequest): HubRemoteStartAnswer {
    const child = getHubChild(childId)
    if (!child || parentId !== r.parentId || getHubParent(parentId)?.remoteHub !== r.desktopInstallId)
      return { ok: false, error: 'Another chat here already has that child id.' }
    if (isOpenChildPhase(child.phase))
      return { ok: true, phase: child.phase as 'starting' | 'open', mode: child.grantedMode }
    if (child.phase === 'settled') return { ok: false, error: 'That child is settled here.' }
    const summary = lastHubWakeOf(childId)?.summary ?? 'It failed to start.'
    // Paths in git and clone errors hold this machine's user name: it stays here.
    const home = this.io.homeDir().replace(/\/+$/, '')
    const error = summary.replace(/^Failed to start: /, '')
    return { ok: false, error: home ? error.split(home).join('~') : error }
  }

  /**
   * The checkout (cloned when planned), the base fetched from a configured
   * remote, then the same steps as a local child. Resolves once the child is
   * open or failed.
   */
  private async startForRemote(batchId: string, r: HubRemoteStartRequest, c: PlannedChild): Promise<void> {
    const span = perfSpan('hub.remote-start', { childId: c.childId, step: 'checkout', clone: r.clonePlanned })
    let projectPath: string
    try {
      projectPath = expandHubPath(r.remoteProjectPath, this.io.homeDir())
      const key = remoteUrlKey(r.repoUrl)
      await this.checkoutOnce(projectPath, async () => {
        if (await this.io.isDir(projectPath)) return
        if (!r.clonePlanned) throw new Error(`${r.remoteProjectPath} is not on this machine, and no clone was planned.`)
        await this.io.clone(r.repoUrl, r.fetch.remoteBranch, projectPath)
      })
      const remote = (await this.io.configuredRemotes(projectPath)).find((x) => remoteUrlKey(x.url) === key)
      if (!remote) throw new Error(`${r.remoteProjectPath} here is not a checkout of ${r.repoUrl}.`)
      await this.io.fetchBase(projectPath, remote.name, r.fetch.remoteBranch, r.baseSha)
      c.depsPlan = await this.io.planDeps(projectPath, r.baseSha, r.deps)
      const disk = await this.diskCheck({ projectPath, children: [c] })
      if (disk.problem) throw new Error(disk.problem)
      span.end({ outcome: 'ok' })
    } catch (err) {
      span.end({ outcome: 'failed' })
      this.fail(r.parentId, c, err)
      return
    }
    const prepared = await this.prepareChild(batchId, r.parentId, projectPath, c, r.deps)
    if (prepared) await prepared.launched
  }

  /**
   * Runs `step` for `projectPath` after any earlier one for it has ended, so
   * two children that plan the same clone clone it once.
   */
  private checkoutOnce(projectPath: string, step: () => Promise<void>): Promise<void> {
    const next = (this.checkouts.get(projectPath) ?? Promise.resolve()).then(step, step)
    this.checkouts.set(projectPath, next)
    const forget = () => {
      if (this.checkouts.get(projectPath) === next) this.checkouts.delete(projectPath)
    }
    next.then(forget, forget)
    return next
  }

  /**
   * Worktree and dependencies; then the launch waits for a slot. Null when the
   * child failed, else its launch, which settles once the child is open or failed
   * (in an object: an async function would wait for a returned promise).
   * One path for a local approval and a start from another machine's hub.
   */
  private async prepareChild(
    batchId: string,
    parentId: string,
    projectPath: string,
    c: PlannedChild,
    depsSetting: HubDepsMode = readHubSettings(this.getSetting).childDependencies,
  ): Promise<{ launched: Promise<void> } | null> {
    const span = perfSpan('hub.start-child', { childId: c.childId, agent: c.agent, location: c.location, deps: c.deps })
    const t0 = performance.now()
    let cwd = projectPath
    let worktreeMs = 0
    let depsMs = 0
    let depsState: ChildDepsState | null = null
    try {
      if (c.location === 'worktree') {
        const snapshot = await this.host.createWorktree(this.worktreeRequest(batchId, parentId, projectPath, c))
        if (snapshot.status !== 'ready' || !snapshot.worktreePath)
          throw new Error(snapshot.error?.message ?? `worktree creation ended ${snapshot.status}`)
        cwd = snapshot.worktreePath
        worktreeMs = performance.now() - t0
        updateHubChild(c.childId, { branch: snapshot.branch ?? null })
        const t1 = performance.now()
        const plans = c.baseSha ? await this.io.planDeps(projectPath, c.baseSha, depsSetting) : []
        depsState = await this.io.prepareDeps(projectPath, cwd, plans)
        depsMs = performance.now() - t1
        const modes = depsState.folders.map((f) => f.mode)
        updateHubChild(c.childId, { depsMode: depsSummary(modes), depsJson: JSON.stringify(depsState) })
        if (linkedFolders(depsState).length > 0) this.track(c.childId, parentId, cwd, depsState)
        const bytes = await this.io.dirBytes(cwd)
        if (bytes !== null) this.diskUse.set(c.childId, bytes)
        const count = (m: HubDepsMode) => modes.filter((x) => x === m).length
        span.end({
          outcome: 'prepared',
          worktreeMs: Math.round(worktreeMs),
          depsMs: Math.round(depsMs),
          linked: count('link'),
          cloned: count('clone'),
          installed: count('install'),
          noDeps: count('none'),
          diskMb: bytes === null ? null : Math.round(bytes / 1024 ** 2),
        })
      } else {
        createConversation(c.childId, projectPath, c.agent, c.title)
        span.end({ outcome: 'prepared' })
      }
    } catch (err) {
      span.end({ outcome: 'failed', step: 'prepare' })
      this.fail(parentId, c, err)
      return null
    }
    const mode = getHubChild(c.childId)?.grantedMode ?? 'sandbox'
    setConversationRuntimeMode(c.childId, mode)
    if (c.instanceId) setConversationProviderInstanceId(c.childId, c.instanceId)
    // The default account's id, as a resumed or moved child's slot names it.
    const slot: HubRunningChild = { providerInstanceId: c.instanceId ?? defaultInstanceId(c.agent), parentId }
    const depsLine = depsState ? depsBriefLine(depsState) : null
    const launched = this.whenSlotFree(c.childId, slot)
      .then(() => this.launch(c, cwd, mode, slot, depsLine))
      .catch((err) => log.error(`launching child ${c.childId} threw`, err))
    return { launched }
  }

  /**
   * A Stop on a child still in `starting`: it gets no first turn. One that
   * waits for a slot stops now; one still being prepared stops at its launch.
   */
  cancelStart(childId: string): void {
    if (getHubChild(childId)?.phase !== 'starting') return
    this.cancelled.add(childId)
    const i = this.waiting.findIndex((w) => w.childId === childId)
    if (i >= 0) this.waiting.splice(i, 1)[0]!.go()
  }

  private async launch(
    c: PlannedChild,
    cwd: string,
    mode: RuntimeMode,
    slot: HubRunningChild,
    depsLine: string | null,
  ): Promise<void> {
    if (this.cancelled.has(c.childId)) return this.stoppedBeforeStart(slot, c)
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
      if (this.cancelled.has(c.childId)) {
        span.end({ outcome: 'stopped' })
        await this.host.stopChild(c.childId).catch((err) => log.warn(`could not stop child ${c.childId}`, err))
        return this.stoppedBeforeStart(slot, c)
      }
      const brief = [c.brief, depsLine, HUB_REPORT_LINE].filter(Boolean).join('\n\n')
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
      if (!this.settled(c.childId)) updateHubChild(c.childId, { phase: 'open' })
      this.host.changed?.(slot.parentId)
      span.end({ outcome: result.status })
    } catch (err) {
      span.end({ outcome: 'failed', step: 'launch' })
      this.running.delete(c.childId)
      this.pump()
      this.fail(slot.parentId, c, err)
    }
  }

  /** A settle ended the child while it was starting: nothing may move it out of `settled`. */
  private settled(childId: string): boolean {
    return getHubChild(childId)?.phase === 'settled'
  }

  /** A settled child: drop what this process keeps about it. */
  forget(childId: string): void {
    if (this.running.delete(childId)) this.pump()
    this.untrack(childId)
    this.lastTurn.delete(childId)
    this.diskUse.delete(childId)
    this.launched.delete(childId)
  }

  private track(childId: string, parentId: string, worktree: string, state: ChildDepsState): void {
    this.linked.set(childId, { worktree, parentId, state })
    trackDependencyLinks(childId, worktree, state)
  }

  private untrack(childId: string): void {
    this.linked.delete(childId)
    untrackDependencyLinks(childId)
  }

  /**
   * After a child turn: a child that installed, removed or rebuilt through a
   * link, or changed its lockfile, changed what the main checkout and the
   * other children run. It is stopped with a `blocked` wake, once.
   */
  private async checkLinks(childId: string): Promise<void> {
    const entry = this.linked.get(childId)
    if (!entry) return
    const span = perfSpan('hub.deps-check', { childId, links: linkedFolders(entry.state).length })
    let problems: string[]
    try {
      problems = await this.io.checkDeps(entry.worktree, entry.state)
    } catch (err) {
      span.end({ outcome: 'error' })
      log.warn(`dependency check of child ${childId} failed`, err)
      return
    }
    span.end({ outcome: problems.length ? 'changed' : 'ok', problems: problems.length })
    if (problems.length === 0 || this.linked.get(childId) !== entry) return
    // One wake per change: the guard paths stay, the check stops until own_dependencies.
    this.linked.delete(childId)
    log.warn('child changed shared dependencies; stopping it', { childId, problems })
    try {
      this.wake({
        parentId: entry.parentId,
        childId,
        kind: 'blocked',
        summary: `Changed shared dependencies: ${problems.join('; ')}. Stopped.`,
        pointer: null,
      })
    } catch (err) {
      log.error(`could not record the blocked wake of ${childId}`, err)
    }
    this.host.changed?.(entry.parentId)
    await this.host.stopChild(childId).catch((err) => log.warn(`could not stop child ${childId}`, err))
  }

  /** `own_dependencies`: the child's linked folders become its own copies. */
  async ownDependencies(threadId: string): Promise<McpToolResult> {
    const childId = resolveRootThreadId(threadId)
    const child = getHubChild(childId)
    const conv = getConversationById(childId)
    const worktree = conv?.worktree_path
    const main = conv?.project_path
    if (!child || !worktree || !main) return toolText('This chat has no linked dependency folders.')
    const state = parseChildDeps(child.depsJson)
    if (linkedFolders(state).length === 0) return toolText('This chat has no linked dependency folders.')
    const span = perfSpan('hub.own-deps', { childId, links: linkedFolders(state).length })
    // Off the check first, so the swap itself does not read as a change.
    this.linked.delete(childId)
    const owned = await this.io.ownDeps(main, worktree, state)
    const modes = owned.state.folders.map((f) => f.mode)
    updateHubChild(childId, { depsMode: depsSummary(modes), depsJson: JSON.stringify(owned.state) })
    if (linkedFolders(owned.state).length > 0) this.track(childId, child.parentId, worktree, owned.state)
    else this.untrack(childId)
    span.end({ outcome: modes.includes('link') ? 'partial' : 'ok', modes: modes.join(',') })
    return toolText(owned.lines.join('\n'))
  }

  private fail(parentId: string, c: Pick<PlannedChild, 'childId'>, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    if (this.settled(c.childId)) return
    log.warn(`child ${c.childId} failed to start: ${message}`)
    try {
      updateHubChild(c.childId, { phase: 'failed_start' })
      this.failedWake(parentId, c.childId, `Failed to start: ${message}`)
    } catch (writeErr) {
      log.error(`could not record the failed start of ${c.childId}`, writeErr)
    }
    this.dropRemoteStartWorktree(parentId, c.childId)
    // A failed child frees its parent's slot (a remote one counts while starting): a waiter may go now.
    this.pump()
    this.host.changed?.(parentId)
  }

  private stoppedBeforeStart(slot: HubRunningChild, c: PlannedChild): void {
    this.cancelled.delete(c.childId)
    if (this.running.get(c.childId) === slot) {
      this.running.delete(c.childId)
      this.pump()
    }
    if (this.settled(c.childId)) return
    log.info('child stopped before its first turn', { childId: c.childId })
    try {
      updateHubChild(c.childId, { phase: 'failed_start' })
      this.wake({
        parentId: slot.parentId,
        childId: c.childId,
        kind: 'stopped',
        summary: 'Stopped before its first turn.',
        pointer: null,
      })
    } catch (err) {
      log.error(`could not record the stop of ${c.childId}`, err)
    }
    this.dropRemoteStartWorktree(slot.parentId, c.childId)
    this.host.changed?.(slot.parentId)
  }

  /**
   * On a child machine, a child of another machine's hub that failed to start
   * keeps no worktree here: its session (if one started) is stopped, then the
   * worktree and the branch its creation made are removed. A local child keeps
   * its worktree for the user.
   */
  private dropRemoteStartWorktree(parentId: string, childId: string): void {
    try {
      if (!getHubParent(parentId)?.remoteHub || !getConversationById(childId)?.worktree_path) return
    } catch (err) {
      log.warn(`could not read child ${childId} after its failed start; its worktree stays`, err)
      return
    }
    void this.host
      .stopChild(childId)
      .catch((err) => log.warn(`could not stop child ${childId}`, err))
      .then(() => {
        const row = getHubChild(childId)
        return row ? removeChildWorktree(row) : 'its row is gone'
      })
      .then((problem) => {
        if (problem) log.warn(`kept the worktree of child ${childId} that failed to start: ${problem}`)
        else log.info('removed the worktree of a child that failed to start', { childId })
      })
      .catch((err) => log.warn(`could not remove the worktree of child ${childId}`, err))
  }

  private failedWake(parentId: string, childId: string, summary: string): void {
    this.wake({
      parentId,
      childId,
      kind: 'failed',
      summary,
      pointer: null,
    })
  }

  /** Stores one of Switchboard's own wakes; one for a parent stub goes to the outbox and the hub client hears of it. */
  private wake(w: { parentId: string; childId: string; kind: HubWakeKind; summary: string; pointer: null }): void {
    const where = insertHubWake({ id: newHubRowId('hw'), ...w })
    if (where === 'outbox') this.host.outboxAdded?.()
  }

  private whenSlotFree(childId: string, slot: HubRunningChild): Promise<void> {
    const s = readHubSettings(this.getSetting)
    // Only waiters on the same account or parent can be ahead of this child.
    const ahead = this.waiting.some(
      (w) => w.slot.providerInstanceId === slot.providerInstanceId || w.slot.parentId === slot.parentId,
    )
    if (!ahead && runSlotFree(slot, this.slotsInUse(), s.runningPerInstance, s.runningPerParent))
      return Promise.resolve()
    log.info('child waits for a run slot', { childId, instance: slot.providerInstanceId })
    return new Promise((go) => this.waiting.push({ childId, slot, go }))
  }

  /** Local turns in flight, plus every open child on another machine for its parent's count. */
  private slotsInUse(): HubRunningChild[] {
    return [...this.running.values(), ...this.remoteSlots()]
  }

  /**
   * Each open child of a parent here that runs on another machine, as a slot
   * of its parent (`runningPerParent` counts it whether or not it runs a turn).
   * Its account is that machine's, so its key never matches a local account.
   */
  remoteSlots(): HubRunningChild[] {
    try {
      return listOpenRemoteHubChildren().map((c) => ({
        providerInstanceId: `${c.machineId}:${c.providerInstanceId ?? c.childId}`,
        parentId: c.parentId,
      }))
    } catch (err) {
      log.warn('could not read the children on other machines for the run slots', err)
      return []
    }
  }

  private pump(): void {
    const s = readHubSettings(this.getSetting)
    for (let i = 0; i < this.waiting.length;) {
      const w = this.waiting[i]!
      if (runSlotFree(w.slot, this.slotsInUse(), s.runningPerInstance, s.runningPerParent)) {
        this.waiting.splice(i, 1)
        // Reserved now, so the next waiter sees it; `launch` sets the same entry.
        this.running.set(w.childId, w.slot)
        w.go()
      } else i++
    }
  }

  private worktreeRequest(
    batchId: string,
    parentId: string,
    projectPath: string,
    c: PlannedChild,
  ): WorktreeCreationRequest {
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

  /** This machine's disk; children on other machines are checked by `remoteDiskCheck`. */
  private async diskCheck(
    plan: StoredPlan,
  ): Promise<{ problem: string | null; needBytes: number | null; freeBytes: number | null }> {
    const worktrees = plan.children.filter((c) => c.location === 'worktree' && !c.machine)
    if (worktrees.length === 0) return { problem: null, needBytes: 0, freeBytes: null }
    const free = await this.io.freeBytes(plan.projectPath)
    let need = 0
    let known = true
    for (const c of worktrees) {
      const checkout = c.baseSha ? await this.io.checkoutBytes(plan.projectPath, c.baseSha) : null
      if (checkout === null) known = false
      need += checkout ?? 0
      for (const f of c.depsPlan ?? []) {
        if (f.mode !== 'clone' && f.mode !== 'install') continue
        const bytes = (await this.io.dirBytes(join(plan.projectPath, f.path))) ?? 0
        need += Math.round(f.mode === 'clone' ? bytes * CLONE_SHARE : bytes)
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

interface RemoteFacts {
  entries: HubMachineEntry[]
  remoteUrls: string[]
  upstream: string | null
}

function openCapProblem(parentId: string, adding: number): string | null {
  const open = listHubChildren(parentId).filter((c) => isOpenChildPhase(c.phase)).length
  if (open + adding <= HUB_OPEN_CHILDREN_MAX) return null
  return `This chat has ${open} open children; at most ${HUB_OPEN_CHILDREN_MAX} may be open at once. Settle some first.`
}

function planDigest(parentId: string, plan: StoredPlan): string {
  // Child ids are fresh on every call, so they are left out: the same tasks give the same digest.
  const tasks = plan.children.map(({ childId: _id, ...rest }) => rest)
  return createHash('sha256')
    .update(JSON.stringify([parentId, plan.projectPath, tasks]))
    .digest('hex')
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
    planDeps: planChildDeps,
    prepareDeps: prepareChildDeps,
    checkDeps: checkChildDeps,
    ownDeps: ownChildDeps,
    async isMainCheckout(cwd) {
      try {
        const [gitDir, common] = (
          await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
        )
          .trim()
          .split('\n')
        return gitDir === common
      } catch (err) {
        log.warn(`could not tell whether ${cwd} is the main checkout`, err)
        return false
      }
    },
    async remoteUrls(cwd) {
      try {
        return parseGitRemoteFetchUrls(await git(cwd, ['remote', '-v']))
      } catch (err) {
        log.debug(`no git remotes in ${cwd}`, err)
        return []
      }
    },
    async remoteBranchesContaining(cwd, sha) {
      try {
        return parseRemoteBranches(
          await git(cwd, ['branch', '-r', '--contains', sha, '--format=%(refname:short) %(symref)']),
        )
      } catch (err) {
        log.warn(`could not list the remote branches that contain ${sha}`, err)
        return []
      }
    },
    async upstreamOf(cwd) {
      try {
        return (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim() || null
      } catch (err) {
        log.debug(`no upstream in ${cwd}`, err)
        return null
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
    async remoteOfBranch(cwd, remoteBranch) {
      try {
        const names = (await git(cwd, ['remote'])).split('\n').filter(Boolean)
        // The longest remote name the branch starts with: remote names may hold a slash.
        const name = names.filter((n) => remoteBranch.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0]
        if (!name) return null
        const url = (await git(cwd, ['remote', 'get-url', '--end-of-options', name])).trim()
        return url ? { url, branch: remoteBranch.slice(name.length + 1) } : null
      } catch (err) {
        log.warn(`could not read the remote of ${remoteBranch}`, err)
        return null
      }
    },
    async configuredRemotes(cwd) {
      try {
        const out = await git(cwd, ['config', '--get-regexp', '^remote\\..*\\.url$'])
        return out.split('\n').flatMap((line) => {
          const m = /^remote\.(.+)\.url (\S+)$/.exec(line.trim())
          return m ? [{ name: m[1]!, url: m[2]! }] : []
        })
      } catch (err) {
        // Exit 1: no remote at all; anything else: not a repository.
        log.debug(`no configured remotes in ${cwd}`, err)
        return []
      }
    },
    homeDir: () => homedir(),
    async isDir(path) {
      try {
        return (await stat(path)).isDirectory()
      } catch (err) {
        log.debug(`no folder at ${path}`, err)
        return false
      }
    },
    // Loaded on use: the clone module pulls in the project and file handlers.
    clone: async (url, branch, dest) => (await import('../ipc/project-clone')).cloneProjectAndWait(url, branch, dest),
    async fetchBase(cwd, remote, branch, sha) {
      const scratch = `refs/switchboard/fetch/hub-${sha.slice(0, 12)}-${randomBytes(3).toString('hex')}`
      await execFileP(
        'git',
        ['-C', cwd, 'fetch', '--no-tags', '--end-of-options', remote, `+refs/heads/${branch}:${scratch}`],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 16 * 1024 * 1024, timeout: FETCH_TIMEOUT_MS },
      )
      try {
        await git(cwd, ['merge-base', '--is-ancestor', sha, scratch])
      } catch (err) {
        log.warn(`commit ${sha} is not on ${remote}/${branch}`, err)
        throw new Error(`Commit ${sha.slice(0, 7)} is not on ${branch} of that remote.`)
      } finally {
        await git(cwd, ['update-ref', '-d', scratch]).catch((err) =>
          log.warn('could not delete the scratch fetch ref', err),
        )
      }
    },
  }
}

/**
 * The local measured-check service: the only thing on this desktop that may
 * say a check passed.
 *
 * The owner picks the named checks per project in Settings > Labs, each a
 * program and an argument ARRAY. Nothing here is a shell string, so nothing
 * here is parsed by a shell. A run is scheduled ONCE after a bridge-origin
 * turn ends and the checkout has stopped changing, keyed by the chat, the
 * definition hash and the source snapshot, so the same code is never checked
 * twice and a read never starts a run. A new turn cancels a run in flight,
 * and a source change during a run is recorded (the result then reads as
 * stale, never as a measurement of the current tree).
 *
 * The service records only what it observed: the definition hash, where it
 * ran, the trees before and after, the real exit code or signal, and a
 * SHA-256 of the MASKED output. No log text is stored, and an agent's words
 * never reach this table.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import type { BridgeCheckDefinition } from '@shared/bridge'
import type { RuntimeEvent } from '@shared/provider-events'
import {
  bridgeCheckDefinitionHash,
  cancelRunningBridgeCheckRuns,
  claimBridgeCheckRun,
  finishBridgeCheckRun,
  getBridgeOrigin,
  getConversationExecutionRoot,
  resolveRootThreadId,
  setBridgeOriginBaseline,
} from '../db/database'
import { maskStoredText } from '../db/secret-mask'
import { createMainLogger } from '../logger'
import { readBridgeGitFacts, type BridgeGitFacts } from './git-facts'
import type { AllowedProject } from './read-service'

const log = createMainLogger('bridge:checks')

/** How long the checkout must stop changing before a run starts. */
const SETTLE_MS = 1_500
/** A check that runs longer than this is killed and recorded as unavailable, never as a pass. */
export const BRIDGE_CHECK_TIMEOUT_MS = 10 * 60 * 1000
/** Output kept for the digest. Past this the digest covers the first bytes and `log_bytes` says so. */
const LOG_MAX_BYTES = 256 * 1024
/** Threads whose edited files are remembered between a turn's end and its run. */
const EDITS_MAX_THREADS = 200

export interface BridgeCheckProcessResult {
  /** The process's real exit code, or null when a signal ended it. */
  code: number | null
  signal: string | null
  /** stdout and stderr as the service captured them, already capped. */
  output: string
  bytes: number
  /** The program could not be started at all. */
  failedToStart: boolean
  timedOut: boolean
}

export interface BridgeCheckHost {
  /** The `instinct_bridge` flag. Nothing is scheduled while it is off. */
  enabled(): boolean
  /** The owner's allowed projects on this desktop, with their policies. */
  allowed(): AllowedProject[]
  now(): number
  /** Test seam: runs one check definition. */
  run?(input: {
    definition: BridgeCheckDefinition
    cwd: string
    signal: AbortSignal
  }): Promise<BridgeCheckProcessResult>
  /** Test seam: reads the checkout. */
  facts?(cwd: string): Promise<BridgeGitFacts | null>
  settleMs?: number
}

/**
 * Paths a definition names inside the execution root: the program when it is
 * a path, and every argument that is not an option and resolves inside the
 * root. A turn that wrote one of these changed the check itself.
 */
export function bridgeCheckDefinitionPaths(def: BridgeCheckDefinition, root: string): string[] {
  const inside = (token: string): string | null => {
    if (token.startsWith('-')) return null
    const full = isAbsolute(token) ? token : resolve(root, token)
    const rel = relative(root, full)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null
  }
  const tokens = [def.program.includes('/') ? def.program : '', ...def.args].filter((t) => t !== '')
  return [...new Set(tokens.map(inside).filter((p): p is string => p !== null))]
}

/** True when the turn wrote a file the definition names. */
export function bridgeCheckDefinitionTouched(
  def: BridgeCheckDefinition,
  root: string,
  editedRelPaths: readonly string[],
): boolean {
  if (editedRelPaths.length === 0) return false
  const named = new Set(bridgeCheckDefinitionPaths(def, root))
  return editedRelPaths.some((p) => named.has(p))
}

function defaultRun(input: {
  definition: BridgeCheckDefinition
  cwd: string
  signal: AbortSignal
}): Promise<BridgeCheckProcessResult> {
  return new Promise((done) => {
    const chunks: string[] = []
    let bytes = 0
    let kept = 0
    let timedOut = false
    // No shell: the program and its arguments go to execvp as they are.
    const child = spawn(input.definition.program, input.definition.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, BRIDGE_CHECK_TIMEOUT_MS)
    timer.unref?.()
    const onAbort = () => child.kill('SIGKILL')
    input.signal.addEventListener('abort', onAbort, { once: true })
    const take = (data: Buffer) => {
      bytes += data.length
      if (kept >= LOG_MAX_BYTES) return
      const text = data.toString('utf8')
      chunks.push(text)
      kept += text.length
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    const finish = (result: BridgeCheckProcessResult) => {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      done(result)
    }
    child.on('error', (err) => {
      log.warn('a configured check could not start', { name: input.definition.name, err: String(err) })
      finish({ code: null, signal: null, output: '', bytes: 0, failedToStart: true, timedOut })
    })
    child.on('close', (code, signal) => {
      finish({
        code,
        signal: signal ?? null,
        output: chunks.join('').slice(0, LOG_MAX_BYTES),
        bytes,
        failedToStart: false,
        timedOut,
      })
    })
  })
}

export class BridgeCheckService {
  /** Root chat id to the controller of the run or settle in flight for it. */
  private readonly inFlight = new Map<string, AbortController>()
  /** Root chat id to the files its last turn changed, as the diff cards saw them. */
  private readonly edits = new Map<string, Set<string>>()
  private disposed = false

  constructor(private readonly host: BridgeCheckHost) {}

  /**
   * A bridge call reached the chat: record the checkout as the baseline a
   * later read diffs against, before the turn runs. Fire and forget; a
   * checkout that cannot be read leaves the baseline as it was.
   */
  async noteBridgeCall(chatId: string, cwd: string): Promise<void> {
    const facts = await this.facts(cwd)
    if (!facts) return
    try {
      setBridgeOriginBaseline(chatId, { tree: facts.tree, commit: facts.head, at: this.host.now() })
    } catch (err) {
      log.warn('could not record the bridge turn baseline', { err: String(err) })
    }
  }

  /** Subscribed to the registry's event bus. */
  noteEvent(event: RuntimeEvent): void {
    if (!('threadId' in event) || typeof event.threadId !== 'string') return
    if (event.type === 'file.edited') {
      this.noteEdit(event.threadId, event.relPath)
      return
    }
    // A turn that starts invalidates whatever was scheduled: the source is about to change.
    if (event.type === 'tool.started' || (event.type === 'turn.dequeued' && event.reason === 'started')) {
      this.cancel(event.threadId)
      return
    }
    if (event.type === 'turn.completed') void this.onTurnEnded(event.threadId)
  }

  /** Stops anything in flight for a chat and marks its running rows cancelled. */
  cancel(chatId: string): void {
    const root = this.root(chatId)
    const controller = this.inFlight.get(root)
    if (!controller) return
    this.inFlight.delete(root)
    controller.abort()
    try {
      cancelRunningBridgeCheckRuns(root)
    } catch (err) {
      log.warn('could not cancel the running check rows', { err: String(err) })
    }
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.inFlight.values()) controller.abort()
    this.inFlight.clear()
    this.edits.clear()
  }

  /**
   * A turn ended on a chat with a bridge origin: wait for its checkout to
   * stop changing, then run each configured check that has no result for
   * this source snapshot yet.
   */
  async onTurnEnded(chatId: string): Promise<void> {
    if (this.disposed || !this.host.enabled()) return
    const root = this.root(chatId)
    const plan = this.plan(root)
    if (!plan) return
    this.cancel(root)
    const controller = new AbortController()
    this.inFlight.set(root, controller)
    try {
      const stable = await this.settle(plan.cwd, controller.signal)
      if (!stable || controller.signal.aborted) {
        if (!stable) log.info('the checkout kept changing, so no check ran', { chatId: root })
        return
      }
      const edited = [...(this.edits.get(root) ?? [])]
      this.edits.delete(root)
      for (const definition of plan.checks) {
        if (controller.signal.aborted) return
        await this.runOne({ root, plan, definition, before: stable, edited, signal: controller.signal })
      }
    } catch (err) {
      log.warn('scheduling the configured checks failed', { chatId: root, err: String(err) })
    } finally {
      if (this.inFlight.get(root) === controller) this.inFlight.delete(root)
    }
  }

  private async runOne(input: {
    root: string
    plan: { cwd: string; projectId: string; revision: number | null }
    definition: BridgeCheckDefinition
    before: BridgeGitFacts
    edited: string[]
    signal: AbortSignal
  }): Promise<void> {
    const { root, plan, definition, before } = input
    const definitionChanged = bridgeCheckDefinitionTouched(definition, plan.cwd, input.edited)
    const claim = claimBridgeCheckRun({
      conversationId: root,
      projectId: plan.projectId,
      name: definition.name,
      definitionHash: bridgeCheckDefinitionHash(definition),
      cwd: plan.cwd,
      executionRootRevision: plan.revision,
      // Commit-bound only on a clean tree: a dirty run names its snapshot instead.
      commit: before.dirty ? null : before.head,
      treeBefore: before.tree,
      dirty: before.dirty,
      definitionChanged,
      now: this.host.now(),
    })
    // A run for this chat, definition and source already exists: never a second.
    if (!claim) return
    const result = await (this.host.run ?? defaultRun)({ definition, cwd: plan.cwd, signal: input.signal })
    const after = await this.facts(plan.cwd)
    if (result.failedToStart || result.timedOut) {
      finishBridgeCheckRun(claim.runId, {
        state: 'unavailable',
        signal: result.signal,
        treeAfter: after?.tree ?? null,
        now: this.host.now(),
      })
      return
    }
    if (input.signal.aborted || result.code === null) {
      finishBridgeCheckRun(claim.runId, {
        state: 'cancelled',
        signal: result.signal,
        treeAfter: after?.tree ?? null,
        now: this.host.now(),
      })
      return
    }
    // The owner's saved secrets never reach the digest: it covers the masked text.
    const masked = result.output === '' ? '' : maskStoredText(root, result.output)
    finishBridgeCheckRun(claim.runId, {
      state: 'finished',
      exitCode: result.code,
      signal: result.signal,
      logDigest: masked === '' ? null : createHash('sha256').update(masked).digest('hex'),
      logBytes: result.bytes,
      treeAfter: after?.tree ?? null,
      now: this.host.now(),
    })
    log.info('configured check measured', {
      chatId: root,
      name: definition.name,
      exitCode: result.code,
      sourceChanged: after !== null && after.tree !== before.tree,
    })
  }

  /** The checkout once it has stopped changing, or null when it keeps moving or cannot be read. */
  private async settle(cwd: string, signal: AbortSignal): Promise<BridgeGitFacts | null> {
    const wait = this.host.settleMs ?? SETTLE_MS
    const first = await this.facts(cwd)
    if (!first || signal.aborted) return null
    await new Promise<void>((done) => {
      const timer = setTimeout(done, wait)
      timer.unref?.()
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          done()
        },
        { once: true },
      )
    })
    if (signal.aborted) return null
    const second = await this.facts(cwd)
    return second && second.tree === first.tree ? second : null
  }

  /** What to run for a chat: null when it has no bridge origin, no allowed project or no configured check. */
  private plan(
    root: string,
  ): { cwd: string; projectId: string; revision: number | null; checks: BridgeCheckDefinition[] } | null {
    const origin = getBridgeOrigin(root)
    if (!origin) return null
    const project = this.host.allowed().find((a) => a.policy.project_id === origin.projectId)
    // An unconfigured check stays not_measured: nothing runs and nothing is recorded.
    if (!project || project.policy.checks.length === 0) return null
    const executionRoot = getConversationExecutionRoot(root)
    const cwd = executionRoot?.worktreePath ?? executionRoot?.projectPath
    if (!cwd) return null
    return {
      cwd,
      projectId: project.policy.project_id,
      revision: executionRoot?.revision ?? null,
      checks: project.policy.checks,
    }
  }

  private facts(cwd: string): Promise<BridgeGitFacts | null> {
    return (this.host.facts ?? readBridgeGitFacts)(cwd)
  }

  private noteEdit(threadId: string, relPath: string): void {
    const root = this.root(threadId)
    const set = this.edits.get(root) ?? new Set<string>()
    set.add(relPath)
    this.edits.delete(root)
    this.edits.set(root, set)
    if (this.edits.size > EDITS_MAX_THREADS) this.edits.delete(this.edits.keys().next().value!)
  }

  private root(chatId: string): string {
    try {
      return resolveRootThreadId(chatId)
    } catch (err) {
      log.warn('could not resolve the chat root for a check', { err: String(err) })
      return chatId
    }
  }
}

let service: BridgeCheckService | null = null

export function setBridgeCheckService(next: BridgeCheckService | null): void {
  service = next
}

/** Null on a backend that runs no measured checks. */
export function bridgeCheckService(): BridgeCheckService | null {
  return service
}

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
 * stale, never as a measurement of the current tree). Nothing is scheduled
 * or spawned while a stop of bridge work stands, and a stop kills a run in
 * flight and records it as cancelled (`cancelAll`, called by the stop
 * service): a program this desktop starts on its own is bridge work.
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
  readBridgeStopRecord,
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
/** Threads whose edited files are remembered between a bridge call and its runs. */
const EDITS_MAX_THREADS = 200
/** Paths kept per chat. Past this nothing more is recorded and the set, now incomplete, attributes nothing. */
const EDITS_MAX_PATHS = 2_000

/**
 * Files in the execution root that commonly decide what a runner does, so a
 * turn that wrote one may have changed what a check runs without touching
 * any path the definition names (`npm run test` and `scripts.test`, say).
 * The flag this raises is one way only: it means the chat touched something
 * that decides what the check runs.
 */
const BRIDGE_CHECK_DEFINING_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'Makefile',
  'pyproject.toml',
  'pytest.ini',
  'tox.ini',
  'Cargo.toml',
  'go.mod',
  'build.gradle',
  'build.gradle.kts',
]
/** Everything under this top-level directory counts too: a check usually runs one of its files. */
const BRIDGE_CHECK_DEFINING_DIR = 'scripts/'

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

/**
 * True when the turn wrote a file the definition names, or one of the files
 * that decide what a runner does (`BRIDGE_CHECK_DEFINING_FILES`). False is
 * not proof the check is unchanged: a runner can reach what it runs through
 * any file, and nothing here follows that indirection.
 */
export function bridgeCheckDefinitionTouched(
  def: BridgeCheckDefinition,
  root: string,
  editedRelPaths: readonly string[],
): boolean {
  if (editedRelPaths.length === 0) return false
  const named = new Set(bridgeCheckDefinitionPaths(def, root))
  return editedRelPaths.some(
    (p) => named.has(p) || BRIDGE_CHECK_DEFINING_FILES.includes(p) || p.startsWith(BRIDGE_CHECK_DEFINING_DIR),
  )
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

/** The paths a chat changed since its baseline: all of them, and those its own edit tools wrote. */
interface ChatEdits {
  all: Set<string>
  mine: Set<string>
  /** False once a set hit its cap, so `mine` can no longer cover a diff. */
  complete: boolean
}

export class BridgeCheckService {
  /** Root chat id to the controller of the run or settle in flight for it. */
  private readonly inFlight = new Map<string, AbortController>()
  /** Root chat id to what it changed since its baseline, as the diff cards saw it. */
  private readonly edits = new Map<string, ChatEdits>()
  private disposed = false

  constructor(private readonly host: BridgeCheckHost) {}

  /**
   * A bridge call reached the chat: record the checkout as the baseline a
   * later read diffs against. The caller awaits this BEFORE the turn can
   * write, or the baseline would already hold the turn's own changes. A
   * checkout that cannot be read leaves the baseline as it was.
   */
  async noteBridgeCall(chatId: string, cwd: string): Promise<void> {
    const root = this.root(chatId)
    const facts = await this.facts(cwd)
    if (!facts) return
    try {
      setBridgeOriginBaseline(root, { tree: facts.tree, commit: facts.head, at: this.host.now() })
      // The edits a read attributes are the ones made after this baseline.
      this.edits.delete(root)
    } catch (err) {
      log.warn('could not record the bridge turn baseline', { err: String(err) })
    }
  }

  /**
   * The paths this chat's own edit tools wrote since its baseline. Null when
   * nothing recorded them (a restart, or a set past its cap), which
   * attributes nothing to the chat.
   */
  writtenSinceBaseline(chatId: string): readonly string[] | null {
    const edits = this.edits.get(this.root(chatId))
    if (!edits || !edits.complete) return null
    return [...edits.mine]
  }

  /** Subscribed to the registry's event bus. */
  noteEvent(event: RuntimeEvent): void {
    if (!('threadId' in event) || typeof event.threadId !== 'string') return
    if (event.type === 'file.edited') {
      // Only an absent `noRevert` means the turn's checkpoint saw this chat's own tools write it.
      this.noteEdit(event.threadId, event.relPath, event.noRevert === undefined)
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

  /**
   * A stop of bridge work covers a check it started: every run in flight is
   * killed and recorded as cancelled, never as the pass or the fail it did
   * not observe. The stop record is written first, so nothing starts again.
   */
  cancelAll(): void {
    for (const chatId of [...this.inFlight.keys()]) this.cancel(chatId)
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
    if (this.stopped(root)) {
      log.info('bridge work is stopped, so no check was scheduled', { chatId: root })
      return
    }
    this.cancel(root)
    const controller = new AbortController()
    this.inFlight.set(root, controller)
    try {
      const stable = await this.settle(plan.cwd, controller.signal)
      if (!stable || controller.signal.aborted) {
        if (!stable) log.info('the checkout kept changing, so no check ran', { chatId: root })
        return
      }
      const edited = [...(this.edits.get(root)?.all ?? [])]
      for (const definition of plan.checks) {
        // The stop record is read again before each program: a kill may have come while one ran.
        if (controller.signal.aborted || this.stopped(root)) return
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

  /**
   * No check is scheduled or spawned while a kill stands, or after a stop of
   * all bridge work that came since this chat's last bridge call: the owner
   * stopped the work, and a program this desktop starts on its own is part
   * of it.
   */
  private stopped(root: string): boolean {
    try {
      const stop = readBridgeStopRecord()
      if (stop.killed) return true
      const origin = getBridgeOrigin(root)
      return origin !== null && origin.stopGeneration < stop.generation
    } catch (err) {
      // A stop that cannot be read is treated as standing: a check is never the safe default.
      log.warn('could not read the bridge stop record for a check', { err: String(err) })
      return true
    }
  }

  private noteEdit(threadId: string, relPath: string, mine: boolean): void {
    const root = this.root(threadId)
    const edits = this.edits.get(root) ?? { all: new Set<string>(), mine: new Set<string>(), complete: true }
    if (edits.all.size >= EDITS_MAX_PATHS) edits.complete = false
    else {
      edits.all.add(relPath)
      if (mine) edits.mine.add(relPath)
    }
    this.edits.delete(root)
    this.edits.set(root, edits)
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

/**
 * What `read_chat` can prove about a chat, built on this desktop from things
 * a recorder here observed: git, the existing pull request service and the
 * local measured-check service.
 *
 * Nothing the agent said reaches this file. A provider shell transcript,
 * "all tests passed" and a `report_to_hub` result are agent output and stay
 * in `agent_reply`. Every fact carries its producer, when it was observed,
 * the commit or tree it is about and one of `measured`, `not_measured`,
 * `unavailable` or `stale`. A fact that could not be read is `unavailable`,
 * never an absence of a problem.
 */
import {
  emptyBridgeEvidence,
  rollUpBridgeEvidence,
  type BridgeCheckEvidence,
  type BridgeCodeEvidence,
  type BridgeEvidence,
  type BridgeEvidenceStatus,
  type BridgePrEvidence,
} from '@shared/bridge'
import { prKey, type PrRef, type PrState } from '@shared/pull-requests'
import {
  bridgeCheckOutcome,
  getBridgeOrigin,
  getConversationExecutionRoot,
  listBridgeCheckRuns,
  listConversationPullRequests,
  projectBridgeCheckRun,
  sharesExecutionRoot,
  type BridgeCheckRun,
} from '../db/database'
import { createMainLogger } from '../logger'
import { bridgeCheckService } from './check-service'
import { listChangedFiles, readBridgeGitFacts, type BridgeGitFacts } from './git-facts'

const log = createMainLogger('bridge:evidence')

/** What the pull request service answers for one linked pull request. */
export interface BridgePrReading {
  url: string
  sourceBranch: string | null
  state: PrState
  headSha: string | null
  checks: { state: 'success' | 'failure' | 'pending' | 'none'; total: number; passed: number; failed: number }
}

export interface BridgeEvidenceDeps {
  now(): number
  /** The checkout the chat runs in, or null when it has none. */
  executionRoot(chatId: string): { cwd: string; revision: number | null } | null
  facts(cwd: string): Promise<BridgeGitFacts | null>
  /** The paths that differ from the baseline tree, or null when the diff cannot be read. */
  changedFiles(cwd: string, fromTree: string, toTree: string): Promise<string[] | null>
  /** True when another chat is rooted at the same checkout, so nothing here proves who wrote a file. */
  shared(chatId: string, cwd: string): boolean
  baselineTree(chatId: string): string | null
  /**
   * The paths this chat's own edit tools wrote since the baseline, from the
   * turn's checkpoint. Null when that set is not known (nothing recorded it,
   * or it ran past its cap), which attributes nothing.
   */
  writtenSinceBaseline(chatId: string): readonly string[] | null
  prLinks(chatId: string): PrRef[]
  /** Null when the host could not be read: that is `unavailable`, never "no pull request". */
  readPr(ref: PrRef): Promise<BridgePrReading | null>
  checkRuns(chatId: string): BridgeCheckRun[]
}

/**
 * A read is polled (Instinct backs off from 5 s to 60 s), so the two costly
 * reads are held briefly: a working-tree snapshot rehashes a dirty repository
 * and a pull request read runs the host CLI. The cache is per process and
 * holds at most 32 keys.
 */
const GIT_TTL_MS = 15_000
const PR_TTL_MS = 60_000
const CACHE_MAX = 32

function heldReader<T>(ttl: number, now: () => number): (key: string, read: () => Promise<T>) => Promise<T> {
  const held = new Map<string, { at: number; value: Promise<T> }>()
  return (key, read) => {
    const hit = held.get(key)
    if (hit && now() - hit.at < ttl) return hit.value
    const value = read()
    held.delete(key)
    held.set(key, { at: now(), value })
    if (held.size > CACHE_MAX) held.delete(held.keys().next().value!)
    return value
  }
}

export function bridgeEvidenceDeps(
  readPr: (ref: PrRef) => Promise<BridgePrReading | null>,
  now: () => number = Date.now,
): BridgeEvidenceDeps {
  const heldFacts = heldReader<BridgeGitFacts | null>(GIT_TTL_MS, now)
  const heldPr = heldReader<BridgePrReading | null>(PR_TTL_MS, now)
  return {
    now,
    executionRoot: (chatId) => {
      const root = getConversationExecutionRoot(chatId)
      const cwd = root?.worktreePath ?? root?.projectPath
      return cwd ? { cwd, revision: root?.revision ?? null } : null
    },
    facts: (cwd) => heldFacts(cwd, () => readBridgeGitFacts(cwd)),
    changedFiles: (cwd, from, to) => listChangedFiles(cwd, from, to),
    shared: (chatId, cwd) => sharesExecutionRoot(chatId, cwd),
    baselineTree: (chatId) => getBridgeOrigin(chatId)?.baselineTree ?? null,
    writtenSinceBaseline: (chatId) => bridgeCheckService()?.writtenSinceBaseline(chatId) ?? null,
    prLinks: (chatId) => listConversationPullRequests(chatId).map((link) => link.ref),
    readPr: (ref) => heldPr(prKey(ref), () => readPr(ref)),
    checkRuns: (chatId) => listBridgeCheckRuns(chatId),
  }
}

/**
 * The reader a backend keeps for the whole process. The holds above live in
 * the deps, so they only work while one set of deps serves every read: deps
 * built per call make each poll run a working-tree snapshot and a pull
 * request read again.
 */
export function bridgeEvidenceReader(
  readPr: (ref: PrRef) => Promise<BridgePrReading | null>,
  now: () => number = Date.now,
): (chatId: string) => Promise<BridgeEvidence> {
  const deps = bridgeEvidenceDeps(readPr, now)
  return (chatId) => buildBridgeEvidence(chatId, deps)
}

/** The evidence for one chat. Reads only; it never starts a check and never writes. */
export async function buildBridgeEvidence(chatId: string, deps: BridgeEvidenceDeps): Promise<BridgeEvidence> {
  const observedAt = new Date(deps.now()).toISOString()
  const root = deps.executionRoot(chatId)
  if (!root) return emptyBridgeEvidence(observedAt)
  const facts = await deps.facts(root.cwd).catch((err: unknown) => {
    log.warn('reading the checkout for evidence failed', { err: String(err) })
    return null
  })
  const code = await codeEvidence(chatId, root, facts, observedAt, deps)
  const checks = checkEvidence(chatId, facts, observedAt, deps)
  return { code, pull_requests: await prEvidence(chatId, facts, observedAt, deps), checks }
}

async function codeEvidence(
  chatId: string,
  root: { cwd: string; revision: number | null },
  facts: BridgeGitFacts | null,
  observedAt: string,
  deps: BridgeEvidenceDeps,
): Promise<BridgeCodeEvidence> {
  const base: Omit<BridgeCodeEvidence, 'status' | 'note'> = {
    producer: 'git',
    observed_at: observedAt,
    commit: facts?.head ?? null,
    tree: facts?.tree ?? null,
    branch: facts?.branch ?? null,
    dirty: facts?.dirty ?? false,
    baseline_tree: deps.baselineTree(chatId),
    changed_files: null,
    execution_root_revision: root.revision,
    attribution: 'unknown',
  }
  if (!facts) return { ...base, status: 'unavailable', note: 'The chat folder could not be read as a git checkout.' }
  const changed =
    base.baseline_tree === null
      ? null
      : await deps.changedFiles(root.cwd, base.baseline_tree, facts.tree).catch((err: unknown) => {
          log.warn('diffing against the bridge baseline failed', { err: String(err) })
          return null
        })
  // A shared checkout stays unknown: another chat or the owner may have written these files.
  const shared = deps.shared(chatId, root.cwd)
  // Attribution needs the stronger evidence: the turn's own checkpoint wrote
  // every changed file. An editor's change is in the diff and in no written
  // set, so a chat alone in its checkout proves nothing by itself.
  const written = deps.writtenSinceBaseline(chatId)
  const mineSet = written === null ? null : new Set(written)
  const mine =
    !shared && changed !== null && changed.length > 0 && mineSet !== null && changed.every((p) => mineSet.has(p))
  const notes: string[] = []
  if (facts.dirty) notes.push('The working tree has changes that are not committed.')
  if (changed?.length === 0) notes.push('Nothing differs from the baseline recorded for the last bridge call.')
  if (base.baseline_tree === null) notes.push('No baseline was recorded, so no diff was measured.')
  if (shared) notes.push('Another chat shares this checkout, so who made a change is unknown.')
  else if (!mine && changed !== null && changed.length > 0)
    notes.push('A changed file is not in what this chat wrote, so who made it is unknown.')
  return {
    ...base,
    changed_files: changed?.length ?? null,
    attribution: mine ? 'bridge_chat' : 'unknown',
    status: 'measured',
    note: notes.join(' ') || 'The checkout matches the commit it is on.',
  }
}

async function prEvidence(
  chatId: string,
  facts: BridgeGitFacts | null,
  observedAt: string,
  deps: BridgeEvidenceDeps,
): Promise<{ status: BridgeEvidenceStatus; items: BridgePrEvidence[] }> {
  const refs = deps.prLinks(chatId)
  if (refs.length === 0) return { status: 'not_measured', items: [] }
  const items = await Promise.all(
    refs.map(async (ref): Promise<BridgePrEvidence> => {
      const base = {
        producer: 'pull_request_service' as const,
        observed_at: observedAt,
        number: ref.number,
        commit: facts?.head ?? null,
        tree: null,
      }
      const read = await deps.readPr(ref).catch((err: unknown) => {
        log.warn('reading a linked pull request for evidence failed', { host: ref.host, err: String(err) })
        return null
      })
      if (!read)
        return {
          ...base,
          status: 'unavailable',
          url: null,
          source_branch: null,
          state: null,
          head_commit: null,
          checks: null,
          note: 'The host could not be read, so this pull request is unknown, not absent.',
        }
      // A link alone proves nothing: the pull request must be on the commit this checkout is on.
      const matches = read.headSha !== null && facts?.head != null && read.headSha === facts.head
      // With no checkout to compare against, the pull request was read but not judged.
      const status = facts === null ? 'unavailable' : matches ? 'measured' : 'stale'
      return {
        ...base,
        status,
        url: read.url,
        source_branch: read.sourceBranch,
        state: read.state,
        head_commit: read.headSha,
        checks: read.checks,
        note:
          facts === null
            ? 'The checkout could not be read, so the pull request head was not compared with it.'
            : matches
              ? "The pull request head is the commit this chat's checkout is on."
              : "The pull request head is not the commit this chat's checkout is on, so it may not hold this work.",
      }
    }),
  )
  return { status: rollUpBridgeEvidence(items.map((i) => i.status)), items }
}

function checkEvidence(
  chatId: string,
  facts: BridgeGitFacts | null,
  observedAt: string,
  deps: BridgeEvidenceDeps,
): { status: BridgeEvidenceStatus; items: BridgeCheckEvidence[] } {
  const runs = deps.checkRuns(chatId)
  if (runs.length === 0) return { status: 'not_measured', items: [] }
  const items = runs.map((run): BridgeCheckEvidence => {
    const { status, sourceMoved, current } = projectBridgeCheckRun(run, facts?.tree ?? null)
    const notes: string[] = []
    if (run.state === 'unavailable') {
      notes.push('The check could not be run to a result.')
    } else if (run.state !== 'finished') {
      notes.push('A new turn, a stop or a source change ended this run before it had a result.')
    } else {
      if (sourceMoved) notes.push('The source changed while the check ran, so it did not test one tree.')
      else if (facts === null) notes.push('The checkout could not be read, so this run is not about the code now.')
      else if (!current) notes.push('The source has changed since this run, so it did not test the current tree.')
      else notes.push('The check ran to a result on this exact source.')
      notes.push(
        run.definitionChanged
          ? 'The chat wrote a file that decides what this check runs, so it is not the configured check.'
          : 'No file the chat wrote decides what this check runs, which is not proof the check is unchanged.',
      )
      if (run.dirty) notes.push('The check ran on an uncommitted working tree, named by its snapshot.')
    }
    return {
      producer: 'local_check',
      status,
      observed_at: observedAt,
      commit: run.commit,
      tree: run.treeBefore,
      name: run.name,
      definition_hash: run.definitionHash,
      outcome: bridgeCheckOutcome(run),
      exit_code: run.exitCode,
      signal: run.signal,
      started_at: new Date(run.startedAt).toISOString(),
      ended_at: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
      log_digest: run.logDigest,
      log_bytes: run.logBytes,
      tree_before: run.treeBefore,
      tree_after: run.treeAfter,
      dirty: run.dirty,
      definition_changed: run.definitionChanged,
      note: notes.join(' '),
    }
  })
  return { status: rollUpBridgeEvidence(items.map((i) => i.status)), items }
}

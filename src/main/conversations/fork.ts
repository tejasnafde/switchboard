import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { createMainLogger as createLogger } from '../logger'
import {
  getConversationById,
  createForkedConversation,
  bulkSaveMessages,
  conversationSessionHints,
  listConversationSegments,
  listSessionIdsForThread,
  setConversationPendingHandoff,
} from '../db/database'
import { encodeClaudeProjectPath } from '../projects/session-scanner'
import { resolveProviderInstance } from '../db/providerInstances'
import { claudeCandidateDirs, compareSessionCopies, defaultClaudeDir, listClaudeSessionCopies } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { loadConversationHistory } from './history'
import { loadJsonlCached } from '../agent/jsonl-cache'
import {
  truncateCodexJsonl,
  assembleClaudeFork,
} from '../agent/jsonl-truncate'
import type { GitRunner } from '../worktree'
import type { ChatMessage } from '@shared/types'
import type { WorktreeCreationSnapshot } from '@shared/worktree-creation'

const log = createLogger('fork')

export interface ForkInput {
  sourceConversationId: string
  creationId?: string
  conversationId?: string
  machineId?: string
  requestedAt?: number
  /**
   * 0-based position of the right-clicked message in the renderer's
   * `messages[sourceConversationId]` array. Position-based instead of
   * id-based: the JsonlParser assigns fresh `generateId()`s every reload,
   * so a renderer-side message id won't match anything when the main
   * process re-parses. The renderer's array order is exactly the parser's
   * emission order for both Claude and Codex (same visibility predicates),
   * so `upToIndex + 1` lines up with `truncate*Jsonl`'s 1-based visible
   * count.
   */
  upToIndex: number
  /**
   * Optional: id of the right-clicked message in the renderer's current
   * snapshot. Stored on the new conversation row purely for audit /
   * lineage display - never used to drive truncation logic.
   */
  forkedAtMessageId?: string
  /**
   * When true, also `git worktree add` a fresh branch off the source
   * repo's HEAD and point the new conversation's `projectPath` at it.
   * The slug is derived from the picked message body via
   * `makeBranchSlug`. Worktree creation runs *before* JSONL surgery -
   * if it fails (no git, no commits, etc.), the fork bails entirely
   * and no conversation row is written. See `#5` kickoff doc.
   */
  withWorktree?: boolean
  /**
   * Test seam: lets unit tests inject a stub `GitRunner` instead of
   * shelling out to real git. Defaults to the production runner inside
   * `worktree.ts`. Production callers leave this undefined.
   */
  gitRunner?: GitRunner
}

export interface ForkResult {
  conversation: {
    id: string
    projectPath: string
    agentType: string
    title: string
    parentConversationId: string
    forkedAtMessageId: string
    createdAt: number
  }
  /**
   * Hint the renderer passes back as `resumeSessionId` when calling
   * `provider.startSession`. For Claude forks this is the new session
   * UUID (also the conversation id and the JSONL filename stem). Null
   * for OpenCode (no resume primitive yet) and for Codex when we
   * couldn't locate the source rollout file.
   */
  resumeHint: string | null
  /** Messages copied into the fork (already persisted in the messages table). */
  messages: ChatMessage[]
  /**
   * True when we successfully wrote a truncated JSONL the agent can
   * resume from. False = degraded "summary-only" fallback (renderer
   * shows the messages but the agent has no real context).
   */
  resumable: boolean
  /**
   * Set iff the caller passed `withWorktree: true` and worktree creation
   * succeeded. Both nil otherwise. The renderer surfaces these in a
   * "Forked to <branch>" toast so the user can immediately see the new
   * checkout location.
   */
  worktree?: { path: string; branch: string }
}

export type ForkWorktreeCreationResult = ForkResult | { worktreeCreation: WorktreeCreationSnapshot }

/**
 * Spawn a new conversation that mirrors the first N messages of `source`
 * and is wired so the underlying agent picks up real context - not just a
 * visual transcript. See `docs/notes/session-kickoff-fork-from-message.md`
 * for the full design rationale.
 */
export async function forkConversation(input: ForkInput): Promise<ForkResult> {
  if (input.withWorktree) {
    throw new Error('Worktree forks must be created through the backend worktree transaction.')
  }
  const source = getConversationById(input.sourceConversationId)
  if (!source) {
    throw new Error(`fork: unknown source conversation ${input.sourceConversationId}`)
  }

  // Re-parse the source JSONL the same way `LOAD_SESSION_BY_ID` does so
  // the renderer's positional index lines up with what we cut at on disk.
  const sourceMessages = await loadSourceMessages(source)
  if (input.upToIndex < 0 || input.upToIndex >= sourceMessages.length) {
    throw new Error(
      `fork: upToIndex ${input.upToIndex} out of range for source ${source.id} (len=${sourceMessages.length})`,
    )
  }
  const upToVisibleIndex = input.upToIndex + 1 // 1-based count of kept messages
  const keptMessages = sourceMessages.slice(0, upToVisibleIndex)
  const title = makeForkTitle(source.title)

  const effectiveProjectPath = source.project_path
  const worktreeMeta = null

  // Encode the worktree branch into the conversation title so the
  // sidebar (which just renders `title` verbatim) calls out the new
  // branch without needing parallel knowledge of the worktree columns.
  // Plain forks keep the existing `<source> · fork` shape.
  const displayTitle = title

  const ctx: ForkContext = {
    source,
    input,
    keptMessages,
    title: displayTitle,
    effectiveProjectPath,
    worktreeMeta,
  }

  if (source.agent_type === 'claude-code') return await forkClaude(ctx)
  if (source.agent_type === 'codex') return await forkCodex(ctx)
  // OpenCode (and any other / unknown agent) - degraded summary-only.
  // TODO(opencode-acp): wire this up once ACP exposes a `session/load` (or
  // equivalent) endpoint. Until then a fork gets the visible transcript
  // but the new agent process starts cold without that context.
  return await forkSummaryOnly(ctx, source.agent_type)
}

/**
 * Plumbing struct for the per-agent fork branches. Bundling these into a
 * single arg keeps `forkClaude` / `forkCodex` / `forkSummaryOnly` from
 * sprouting eight positional parameters once the worktree fields landed.
 */
interface ForkContext {
  source: ReturnType<typeof getConversationById> & object
  input: ForkInput
  keptMessages: ChatMessage[]
  title: string
  /** The path the *new* conversation should be rooted at - equals
   *  `source.project_path` for non-worktree forks and the new worktree
   *  path when `withWorktree: true`. */
  effectiveProjectPath: string
  /** Set iff the worktree was successfully created. */
  worktreeMeta: { path: string; branch: string } | null
}

export function resolveNativeForkIndex(
  unifiedMessages: readonly ChatMessage[],
  nativeMessages: readonly ChatMessage[],
  unifiedIndex: number,
): number | null {
  const selected = unifiedMessages[unifiedIndex]
  if (!selected) return null
  const exact = nativeMessages.findIndex((message) => message.id === selected.id)
  if (exact >= 0) return exact
  const legacy = nativeMessages.findIndex((message) =>
    message.role === selected.role
    && message.content === selected.content
    && Math.abs(message.timestamp - selected.timestamp) <= 60_000
  )
  return legacy >= 0 ? legacy : null
}

// ── Claude ────────────────────────────────────────────────────────

async function forkClaude(ctx: ForkContext): Promise<ForkResult> {
  const { source, input, keptMessages, title, effectiveProjectPath, worktreeMeta } = ctx
  // Fragments are located by session id across every profile, because a
  // hardcoded ~/.claude found nothing for 355 of the 361 locatable transcripts
  // on a real install - `claude-code-default` does not even point at ~/.claude.
  // The fork is WRITTEN to the profile the new session will actually run under,
  // keyed by `effectiveProjectPath` so a worktree-backed fork resumes there.
  const targetProjectDir = join(
    resolveProviderInstance('claude-code', null)?.oauthDir ?? defaultClaudeDir(),
    'projects',
    encodeClaudeProjectPath(effectiveProjectPath),
  )
  // The source thread can span multiple JSONL files (Claude SDK rotates
  // session_id during compaction). Read every fragment in chronological
  // order and let `assembleClaudeFork` walk the merged stream - the cut
  // can land anywhere, including past the first fragment, and earlier
  // fragments must come along verbatim or the resume context is broken.
  const fragmentPaths = listClaudeFragmentPaths(source.id)
  const fragments: string[] = []
  const nativeMessages: ChatMessage[] = []
  for (const p of fragmentPaths) {
    const raw = await readFile(p, 'utf-8').catch(() => null)
    if (raw !== null) fragments.push(raw)
    const parsed = await loadJsonlCached(p, 'claude-code')
    if (parsed) nativeMessages.push(...parsed)
  }

  if (fragments.length === 0) {
    log.warn(`fork: no source jsonl for ${source.id}; degrading to summary-only`)
    return await forkSummaryOnly(ctx, 'claude-code')
  }

  const nativeIndex = resolveNativeForkIndex(keptMessages, nativeMessages, keptMessages.length - 1)
  if (nativeIndex === null) {
    log.warn(`fork: selected message is outside Claude-native history for ${source.id}; degrading to summary-only`)
    return await forkSummaryOnly(ctx, 'claude-code')
  }

  const newId = randomUUID()
  const truncated = assembleClaudeFork(fragments, nativeIndex + 1, { newSessionId: newId })

  if (!truncated.anchorUuid || truncated.keptVisibleCount === 0) {
    log.warn(`fork: claude truncate produced empty result for ${source.id}; degrading`)
    return await forkSummaryOnly(ctx, 'claude-code')
  }

  // mkdir is a no-op when source == target (the most common case);
  // necessary the first time a worktree-rooted fork is created since
  // `~/.claude/projects/<encoded-worktree-path>/` won't exist yet.
  await mkdir(targetProjectDir, { recursive: true })
  await writeFile(join(targetProjectDir, `${newId}.jsonl`), truncated.newContent, 'utf-8')

  createForkedConversation({
    id: newId,
    projectPath: effectiveProjectPath,
    agentType: 'claude-code',
    title,
    parentConversationId: source.id,
    forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
    sessionId: newId,
    worktreePath: worktreeMeta?.path ?? null,
    worktreeBranch: worktreeMeta?.branch ?? null,
  })
  bulkSaveMessages(newId, keptMessages.map(toMessageRow))

  log.info(`fork(claude): ${source.id} → ${newId} (${truncated.keptVisibleCount} msgs, anchor ${truncated.anchorUuid})${worktreeMeta ? ` worktree=${worktreeMeta.branch}` : ''}`)

  return {
    conversation: {
      id: newId,
      projectPath: effectiveProjectPath,
      agentType: 'claude-code',
      title,
      parentConversationId: source.id,
      forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
      createdAt: Date.now(),
    },
    resumeHint: newId,
    messages: keptMessages,
    resumable: true,
    worktree: worktreeMeta ?? undefined,
  }
}

/**
 * On-disk JSONL fragments for a Claude thread, oldest first.
 *
 * Resolved by SESSION ID, never by directory: the transcript's location is a
 * function of the profile and the cwd at write time, and both drift. Where two
 * profiles hold the same fragment, the newest wins - same rule as resume.
 */
export function listClaudeFragmentPaths(threadId: string): string[] {
  const dirs = claudeCandidateDirs()
  const paths: string[] = []
  for (const sid of listSessionIdsForThread(threadId)) {
    const copies = dirs.flatMap((dir) => listClaudeSessionCopies(dir, sid))
    if (copies.length === 0) continue
    copies.sort(compareSessionCopies)
    paths.push(copies[0].path)
  }
  return paths
}

// ── Codex ─────────────────────────────────────────────────────────

async function forkCodex(ctx: ForkContext): Promise<ForkResult> {
  const { source, input, keptMessages, title, effectiveProjectPath, worktreeMeta } = ctx
  // Codex stores rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
  // We can locate the source by scanning, but reusing a forked rollout for
  // genuine resume requires Codex app-server cooperation we haven't wired
  // up yet. Truncate the file as a record so audit tools can find the
  // lineage on disk; the renderer treats the resume as best-effort and
  // starts the new Codex session cold.
  // TODO(codex-resume): pipe `resumeSessionId` through the codex adapter's
  // `session/start` JSON-RPC and verify the daemon picks up the truncated
  // rollout - see kickoff doc step 4.
  const newId = randomUUID()
  try {
    const sourceFile = await findCodexRolloutForConversation(source.id)
    if (sourceFile) {
      const raw = await readFile(sourceFile, 'utf-8')
      const nativeMessages = await loadJsonlCached(sourceFile, 'codex') ?? []
      const nativeIndex = resolveNativeForkIndex(keptMessages, nativeMessages, keptMessages.length - 1)
      const truncated = nativeIndex === null ? null : truncateCodexJsonl(raw, nativeIndex + 1)
      if (truncated && truncated.keptVisibleCount > 0) {
        const target = join(dirname(sourceFile), `rollout-fork-${newId}.jsonl`)
        await writeFile(target, truncated.newContent, 'utf-8')
        log.info(`fork(codex): wrote truncated rollout ${target} (resume best-effort)`)
      }
    }
  } catch (err) {
    log.warn(`fork(codex): could not write truncated rollout: ${err}`)
  }

  createForkedConversation({
    id: newId,
    projectPath: effectiveProjectPath,
    agentType: 'codex',
    title,
    parentConversationId: source.id,
    forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
    worktreePath: worktreeMeta?.path ?? null,
    worktreeBranch: worktreeMeta?.branch ?? null,
  })
  bulkSaveMessages(newId, keptMessages.map(toMessageRow))
  // The new Codex process starts cold (the truncated rollout above is an
  // audit record, not a resume). Schedule a context handoff so the fork's
  // first turn carries the transcript preamble - ChatPanel consumes and
  // clears this flag on send.
  setConversationPendingHandoff(newId, source.agent_type)

  return {
    conversation: {
      id: newId,
      projectPath: effectiveProjectPath,
      agentType: 'codex',
      title,
      parentConversationId: source.id,
      forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
      createdAt: Date.now(),
    },
    resumeHint: null,
    messages: keptMessages,
    resumable: false,
    worktree: worktreeMeta ?? undefined,
  }
}

export async function findCodexRolloutForConversation(conversationId: string): Promise<string | null> {
  const segments = listConversationSegments(conversationId)
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].provider !== 'codex') continue
    const path = await findCodexRollout(segments[i].provider_session_id)
    if (path) return path
  }
  const candidates = [...conversationSessionHints(conversationId).reverse(), conversationId]
  for (const candidate of candidates) {
    const path = await findCodexRollout(candidate)
    if (path) return path
  }
  return null
}

export async function findCodexRollout(threadId: string): Promise<string | null> {
  // Walk the dated tree and grep for `<threadId>.jsonl` suffix. The id
  // appears in the filename for sessions created by the Codex CLI itself.
  for (const base of codexCandidateDirs()) {
    const found = await walkForSuffix(join(base, 'sessions'), `${threadId}.jsonl`, 4)
    if (found) return found
  }
  log.warn(`fork(codex): no rollout file for thread ${threadId} in configured Codex homes`)
  return null
}

async function walkForSuffix(dir: string, suffix: string, maxDepth: number): Promise<string | null> {
  if (maxDepth < 0) return null
  let entries: string[] = []
  try { entries = await readdir(dir) } catch { return null }
  for (const name of entries) {
    const full = join(dir, name)
    if (name.endsWith(suffix)) return full
    // Cheap dir test - try to recurse, ignore "not a dir" errors.
    const found = await walkForSuffix(full, suffix, maxDepth - 1)
    if (found) return found
  }
  return null
}

// ── Summary-only fallback (OpenCode, missing source files) ────────

async function forkSummaryOnly(ctx: ForkContext, agentType: string): Promise<ForkResult> {
  const { source, input, keptMessages, title, effectiveProjectPath, worktreeMeta } = ctx
  // No JSONL surgery - just clone the row and the message stream. The
  // new agent process will start cold; the renderer prepends a synthetic
  // system message in `forkAndOpenSession` so the user sees the notice.
  const newId = randomUUID()
  createForkedConversation({
    id: newId,
    projectPath: effectiveProjectPath,
    agentType,
    title,
    parentConversationId: source.id,
    forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
    worktreePath: worktreeMeta?.path ?? null,
    worktreeBranch: worktreeMeta?.branch ?? null,
  })
  bulkSaveMessages(newId, keptMessages.map(toMessageRow))
  // Schedule a context handoff (same as the Codex path): the cold agent's
  // first turn gets the copied transcript replayed as a preamble.
  setConversationPendingHandoff(newId, source.agent_type)

  return {
    conversation: {
      id: newId,
      projectPath: effectiveProjectPath,
      agentType,
      title,
      parentConversationId: source.id,
      forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
      createdAt: Date.now(),
    },
    resumeHint: null,
    messages: keptMessages,
    resumable: false,
    worktree: worktreeMeta ?? undefined,
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function loadSourceMessages(
  source: { id: string; project_path: string; agent_type: string },
): Promise<ChatMessage[]> {
  return (await loadConversationHistory(source.id, source.project_path)).messages
}

function makeForkTitle(sourceTitle: string): string {
  return `${stripForkSuffix(sourceTitle)} · fork`
}

/**
 * Drop the trailing ` · fork` (or ` · <branch>`) suffix so we don't
 * stack `parent · fork · fork/foo` titles when the user forks a fork.
 * Matches both the plain `· fork` shape and the worktree-branch shape
 * from #5; anything that looks like the trailing component starts with
 * ` · ` is treated as a fork suffix and stripped.
 */
function stripForkSuffix(title: string): string {
  return title.replace(/ · fork(\/[^·]*)?$/, '').trim()
}

function toMessageRow(m: ChatMessage): {
  id: string; role: string; content: string; timestamp: number
} {
  // Fresh id so the fork owns its message stream - reusing source ids
  // would collide if `messages.id` ever picks up a UNIQUE constraint.
  return { id: randomUUID(), role: m.role, content: m.content, timestamp: m.timestamp }
}

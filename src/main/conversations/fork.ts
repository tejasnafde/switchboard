import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { createMainLogger as createLogger } from '../logger'
import {
  getConversationById,
  createForkedConversation,
  bulkSaveMessages,
  listSessionIdsForThread,
  getMessagesForConversation,
} from '../db/database'
import { encodeClaudeProjectPath } from '../projects/session-scanner'
import { JsonlParser } from '../agent/jsonl-parser'
import {
  truncateCodexJsonl,
  assembleClaudeFork,
} from '../agent/jsonl-truncate'
import { createForkWorktree, type GitRunner } from '../worktree'
import { makeBranchSlug } from '@shared/branchSlug'
import type { ChatMessage } from '@shared/types'

const log = createLogger('fork')

export interface ForkInput {
  sourceConversationId: string
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
   * lineage display — never used to drive truncation logic.
   */
  forkedAtMessageId?: string
  /**
   * When true, also `git worktree add` a fresh branch off the source
   * repo's HEAD and point the new conversation's `projectPath` at it.
   * The slug is derived from the picked message body via
   * `makeBranchSlug`. Worktree creation runs *before* JSONL surgery —
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

/**
 * Spawn a new conversation that mirrors the first N messages of `source`
 * and is wired so the underlying agent picks up real context — not just a
 * visual transcript. See `docs/notes/session-kickoff-fork-from-message.md`
 * for the full design rationale.
 */
export async function forkConversation(input: ForkInput): Promise<ForkResult> {
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

  // ── Worktree materialization (#5) ────────────────────────────────
  // Done up-front so a git failure aborts the fork before any DB writes
  // or JSONL surgery. The picked message body seeds the slug; on a
  // successful return, `effectiveProjectPath` becomes the new worktree
  // and the conversation row gets `worktree_path` / `worktree_branch`
  // populated alongside `parent_conversation_id`.
  let effectiveProjectPath = source.project_path
  let worktreeMeta: { path: string; branch: string } | null = null
  if (input.withWorktree) {
    const summarySource = keptMessages[keptMessages.length - 1]?.content ?? title
    const slug = makeBranchSlug(stripForSlug(summarySource))
    log.info(`fork: creating worktree for ${source.id} with slug "${slug}"`)
    const wt = await createForkWorktree(
      { repoRoot: source.project_path, baseRef: 'HEAD', slug },
      input.gitRunner,
    )
    effectiveProjectPath = wt.path
    worktreeMeta = wt
  }

  // Encode the worktree branch into the conversation title so the
  // sidebar (which just renders `title` verbatim) calls out the new
  // branch without needing parallel knowledge of the worktree columns.
  // Plain forks keep the existing `<source> · fork` shape.
  const displayTitle = worktreeMeta
    ? `${stripForkSuffix(source.title)} · ${worktreeMeta.branch}`
    : title

  const ctx: ForkContext = {
    source,
    input,
    keptMessages,
    upToVisibleIndex,
    title: displayTitle,
    effectiveProjectPath,
    worktreeMeta,
  }

  if (source.agent_type === 'claude-code') return await forkClaude(ctx)
  if (source.agent_type === 'codex') return await forkCodex(ctx)
  // OpenCode (and any other / unknown agent) — degraded summary-only.
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
  upToVisibleIndex: number
  title: string
  /** The path the *new* conversation should be rooted at — equals
   *  `source.project_path` for non-worktree forks and the new worktree
   *  path when `withWorktree: true`. */
  effectiveProjectPath: string
  /** Set iff the worktree was successfully created. */
  worktreeMeta: { path: string; branch: string } | null
}

/**
 * Trim a message body down to a slug-friendly summary. Strips fenced
 * code blocks (their contents wreck the slug) and inline code, then
 * keeps the first sentence-ish chunk. The hard cap at 80 chars matches
 * what `slugifyForBranch` would slice anyway, but trimming earlier
 * means the slug reflects the topic of the message rather than
 * arbitrary trailing punctuation.
 */
function stripForSlug(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

// ── Claude ────────────────────────────────────────────────────────

async function forkClaude(ctx: ForkContext): Promise<ForkResult> {
  const { source, input, keptMessages, upToVisibleIndex, title, effectiveProjectPath, worktreeMeta } = ctx
  // Always read fragments from the SOURCE project's claude-projects dir
  // (that's where the parent's transcript lives). We write the truncated
  // fork JSONL to the dir keyed by `effectiveProjectPath` so a worktree-
  // backed fork resumes correctly when the SDK cwd is the new worktree.
  const sourceProjectDir = join(homedir(), '.claude', 'projects', encodeClaudeProjectPath(source.project_path))
  const targetProjectDir = join(homedir(), '.claude', 'projects', encodeClaudeProjectPath(effectiveProjectPath))
  // The source thread can span multiple JSONL files (Claude SDK rotates
  // session_id during compaction). Read every fragment in chronological
  // order and let `assembleClaudeFork` walk the merged stream — the cut
  // can land anywhere, including past the first fragment, and earlier
  // fragments must come along verbatim or the resume context is broken.
  const fragmentPaths = await listClaudeFragmentPaths(sourceProjectDir, source.id)
  const fragments: string[] = []
  for (const p of fragmentPaths) {
    const raw = await readFile(p, 'utf-8').catch(() => null)
    if (raw !== null) fragments.push(raw)
  }

  if (fragments.length === 0) {
    log.warn(`fork: no source jsonl for ${source.id}; degrading to summary-only`)
    return await forkSummaryOnly(ctx, 'claude-code')
  }

  const newId = randomUUID()
  const truncated = assembleClaudeFork(fragments, upToVisibleIndex, { newSessionId: newId })

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
 * Resolve the on-disk JSONL fragments for a Claude thread in chronological
 * order. Prefers the `thread_sessions` ancestry chain; falls back to a
 * mtime-sorted dir scan when ancestry isn't recorded (older imported
 * sessions, or threads created before the table existed).
 */
async function listClaudeFragmentPaths(projectDir: string, threadId: string): Promise<string[]> {
  const sessionIds = listSessionIdsForThread(threadId)
  if (sessionIds.length > 0) {
    return sessionIds.map((sid) => join(projectDir, `${sid}.jsonl`))
  }
  // Dir-scan fallback: every `.jsonl` in the project dir, sorted oldest
  // first. The thread root file (`<threadId>.jsonl`) is pinned to the
  // front so a thread with a single fragment hits the obvious file even
  // if its mtime got bumped by an unrelated tool.
  const files = await readdir(projectDir).catch(() => [] as string[])
  const jsonl = files.filter((f) => f.endsWith('.jsonl'))
  const withStat = await Promise.all(jsonl.map(async (f) => {
    const full = join(projectDir, f)
    const s = await stat(full).catch(() => null)
    return { full, mtime: s?.mtimeMs ?? 0, name: f }
  }))
  withStat.sort((a, b) => a.mtime - b.mtime)
  const pref = `${threadId}.jsonl`
  const idx = withStat.findIndex((x) => x.name === pref)
  if (idx > 0) {
    const [pinned] = withStat.splice(idx, 1)
    withStat.unshift(pinned)
  }
  return withStat.map((x) => x.full)
}

// ── Codex ─────────────────────────────────────────────────────────

async function forkCodex(ctx: ForkContext): Promise<ForkResult> {
  const { source, input, keptMessages, upToVisibleIndex, title, effectiveProjectPath, worktreeMeta } = ctx
  // Codex stores rollouts under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
  // We can locate the source by scanning, but reusing a forked rollout for
  // genuine resume requires Codex app-server cooperation we haven't wired
  // up yet. Truncate the file as a record so audit tools can find the
  // lineage on disk; the renderer treats the resume as best-effort and
  // starts the new Codex session cold.
  // TODO(codex-resume): pipe `resumeSessionId` through the codex adapter's
  // `session/start` JSON-RPC and verify the daemon picks up the truncated
  // rollout — see kickoff doc step 4.
  const newId = randomUUID()
  try {
    const sourceFile = await findCodexRollout(source.id)
    if (sourceFile) {
      const raw = await readFile(sourceFile, 'utf-8')
      const truncated = truncateCodexJsonl(raw, upToVisibleIndex)
      if (truncated.keptVisibleCount > 0) {
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

async function findCodexRollout(threadId: string): Promise<string | null> {
  // Walk the dated tree and grep for `<threadId>.jsonl` suffix. The id
  // appears in the filename for sessions created by the Codex CLI itself.
  const root = join(homedir(), '.codex', 'sessions')
  const found = await walkForSuffix(root, `${threadId}.jsonl`, 4) // YYYY/MM/DD/file
  if (!found) {
    log.warn(`fork(codex): no rollout file for thread ${threadId} under ${root}`)
  }
  return found
}

async function walkForSuffix(dir: string, suffix: string, maxDepth: number): Promise<string | null> {
  if (maxDepth < 0) return null
  let entries: string[] = []
  try { entries = await readdir(dir) } catch { return null }
  for (const name of entries) {
    const full = join(dir, name)
    if (name.endsWith(suffix)) return full
    // Cheap dir test — try to recurse, ignore "not a dir" errors.
    const found = await walkForSuffix(full, suffix, maxDepth - 1)
    if (found) return found
  }
  return null
}

// ── Summary-only fallback (OpenCode, missing source files) ────────

async function forkSummaryOnly(ctx: ForkContext, agentType: string): Promise<ForkResult> {
  const { source, input, keptMessages, title, effectiveProjectPath, worktreeMeta } = ctx
  // No JSONL surgery — just clone the row and the message stream. The
  // new agent process will start cold; the renderer prepends a synthetic
  // system message in `forkAndOpenSession` so the user sees the warning.
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
  const sessionIds = listSessionIdsForThread(source.id)
  const all: ChatMessage[] = []

  if (source.agent_type === 'claude-code') {
    const dir = join(homedir(), '.claude', 'projects', encodeClaudeProjectPath(source.project_path))
    // Use the same fragment-resolution path as the truncate flow so a
    // missing thread_sessions row falls back to the mtime-sorted dir scan
    // instead of returning empty.
    const paths = await listClaudeFragmentPaths(dir, source.id)
    for (const path of paths) {
      const raw = await readFile(path, 'utf-8').catch(() => null)
      if (raw === null) continue
      const parser = new JsonlParser((m) => all.push(m), 'claude-code')
      parser.feed(raw); parser.flush()
    }
  } else if (source.agent_type === 'codex') {
    for (const sid of sessionIds) {
      const path = await findCodexRollout(sid)
      if (!path) continue
      const raw = await readFile(path, 'utf-8').catch(() => null)
      if (raw === null) continue
      const parser = new JsonlParser((m) => all.push(m), 'codex')
      parser.feed(raw); parser.flush()
    }
  }
  if (all.length > 0) {
    all.sort((a, b) => a.timestamp - b.timestamp)
    const seen = new Set<string>()
    return all.filter((m) => seen.has(m.id) ? false : (seen.add(m.id), true))
  }

  // Fallback: pull directly from the messages table. Every streamed message
  // is persisted in real-time by `saveMessage`, so the DB is always
  // authoritative — JSONL parse can miss when the rollout file is in a
  // non-standard location (Codex `agent_*` ids), when we haven't wired up
  // on-disk parsing (OpenCode), or when the thread hasn't compacted yet.
  return getMessagesForConversation(source.id).map((row) => ({
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    toolCalls: row.tool_calls ? tryParseJson(row.tool_calls) : undefined,
    images: row.images ? tryParseJson(row.images) : undefined,
  }))
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

function tryParseJson<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T } catch { return undefined }
}

function toMessageRow(m: ChatMessage): {
  id: string; role: string; content: string; timestamp: number
} {
  // Fresh id so the fork owns its message stream — reusing source ids
  // would collide if `messages.id` ever picks up a UNIQUE constraint.
  return { id: randomUUID(), role: m.role, content: m.content, timestamp: m.timestamp }
}

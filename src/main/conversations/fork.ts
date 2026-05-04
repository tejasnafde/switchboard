import { readFile, writeFile, readdir, stat } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { createMainLogger as createLogger } from '../logger'
import {
  getConversationById,
  createForkedConversation,
  bulkSaveMessages,
  listSessionIdsForThread,
} from '../db/database'
import { encodeClaudeProjectPath } from '../projects/session-scanner'
import { JsonlParser } from '../agent/jsonl-parser'
import {
  truncateCodexJsonl,
  assembleClaudeFork,
} from '../agent/jsonl-truncate'
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

  if (source.agent_type === 'claude-code') {
    return await forkClaude(source, input, keptMessages, upToVisibleIndex, title)
  }
  if (source.agent_type === 'codex') {
    return await forkCodex(source, input, keptMessages, upToVisibleIndex, title)
  }
  // OpenCode (and any other / unknown agent) — degraded summary-only.
  // TODO(opencode-acp): wire this up once ACP exposes a `session/load` (or
  // equivalent) endpoint. Until then a fork gets the visible transcript
  // but the new agent process starts cold without that context.
  return await forkSummaryOnly(source, input, keptMessages, title, source.agent_type)
}

// ── Claude ────────────────────────────────────────────────────────

async function forkClaude(
  source: ReturnType<typeof getConversationById> & object,
  input: ForkInput,
  keptMessages: ChatMessage[],
  upToVisibleIndex: number,
  title: string,
): Promise<ForkResult> {
  const projectDir = join(homedir(), '.claude', 'projects', encodeClaudeProjectPath(source.project_path))
  // The source thread can span multiple JSONL files (Claude SDK rotates
  // session_id during compaction). Read every fragment in chronological
  // order and let `assembleClaudeFork` walk the merged stream — the cut
  // can land anywhere, including past the first fragment, and earlier
  // fragments must come along verbatim or the resume context is broken.
  const fragmentPaths = await listClaudeFragmentPaths(projectDir, source.id)
  const fragments: string[] = []
  for (const p of fragmentPaths) {
    const raw = await readFile(p, 'utf-8').catch(() => null)
    if (raw !== null) fragments.push(raw)
  }

  if (fragments.length === 0) {
    log.warn(`fork: no source jsonl for ${source.id}; degrading to summary-only`)
    return await forkSummaryOnly(source, input, keptMessages, title, 'claude-code')
  }

  const newId = randomUUID()
  const truncated = assembleClaudeFork(fragments, upToVisibleIndex, { newSessionId: newId })

  if (!truncated.anchorUuid || truncated.keptVisibleCount === 0) {
    log.warn(`fork: claude truncate produced empty result for ${source.id}; degrading`)
    return await forkSummaryOnly(source, input, keptMessages, title, 'claude-code')
  }

  await writeFile(join(projectDir, `${newId}.jsonl`), truncated.newContent, 'utf-8')

  createForkedConversation({
    id: newId,
    projectPath: source.project_path,
    agentType: 'claude-code',
    title,
    parentConversationId: source.id,
    forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
    sessionId: newId,
  })
  bulkSaveMessages(newId, keptMessages.map(toMessageRow))

  log.info(`fork(claude): ${source.id} → ${newId} (${truncated.keptVisibleCount} msgs, anchor ${truncated.anchorUuid})`)

  return {
    conversation: {
      id: newId,
      projectPath: source.project_path,
      agentType: 'claude-code',
      title,
      parentConversationId: source.id,
      forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
      createdAt: Date.now(),
    },
    resumeHint: newId,
    messages: keptMessages,
    resumable: true,
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

async function forkCodex(
  source: ReturnType<typeof getConversationById> & object,
  input: ForkInput,
  keptMessages: ChatMessage[],
  upToVisibleIndex: number,
  title: string,
): Promise<ForkResult> {
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
    projectPath: source.project_path,
    agentType: 'codex',
    title,
    parentConversationId: source.id,
    forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
  })
  bulkSaveMessages(newId, keptMessages.map(toMessageRow))

  return {
    conversation: {
      id: newId,
      projectPath: source.project_path,
      agentType: 'codex',
      title,
      parentConversationId: source.id,
      forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
      createdAt: Date.now(),
    },
    resumeHint: null,
    messages: keptMessages,
    resumable: false,
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

async function forkSummaryOnly(
  source: ReturnType<typeof getConversationById> & object,
  input: ForkInput,
  keptMessages: ChatMessage[],
  title: string,
  agentType: string,
): Promise<ForkResult> {
  // No JSONL surgery — just clone the row and the message stream. The
  // new agent process will start cold; the renderer prepends a synthetic
  // system message in `forkAndOpenSession` so the user sees the warning.
  const newId = randomUUID()
  createForkedConversation({
    id: newId,
    projectPath: source.project_path,
    agentType,
    title,
    parentConversationId: source.id,
    forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
  })
  bulkSaveMessages(newId, keptMessages.map(toMessageRow))

  return {
    conversation: {
      id: newId,
      projectPath: source.project_path,
      agentType,
      title,
      parentConversationId: source.id,
      forkedAtMessageId: input.forkedAtMessageId ?? `idx:${input.upToIndex}`,
      createdAt: Date.now(),
    },
    resumeHint: null,
    messages: keptMessages,
    resumable: false,
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
  // OpenCode has no on-disk transcript we can re-parse — caller will get
  // an empty list and the fork will be empty too. Acceptable for v1.

  all.sort((a, b) => a.timestamp - b.timestamp)
  const seen = new Set<string>()
  return all.filter((m) => seen.has(m.id) ? false : (seen.add(m.id), true))
}

function makeForkTitle(sourceTitle: string): string {
  const base = sourceTitle.replace(/ · fork$/, '').trim()
  return `${base} · fork`
}

function toMessageRow(m: ChatMessage): {
  id: string; role: string; content: string; timestamp: number
} {
  // Fresh id so the fork owns its message stream — reusing source ids
  // would collide if `messages.id` ever picks up a UNIQUE constraint.
  return { id: randomUUID(), role: m.role, content: m.content, timestamp: m.timestamp }
}

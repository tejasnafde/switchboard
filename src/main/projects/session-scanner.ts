import { readdir, readFile, stat, open } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { generateTitle } from '@shared/auto-title'
import type { SessionSummary, SessionSource } from '@shared/types'
import { createMainLogger } from '../logger'

const log = createMainLogger('projects:scanner')

/**
 * Claude Code encodes paths by replacing / and _ with -
 * e.g. /Users/tejas/Desktop/projects/radicalize_me_public
 *   -> -Users-tejas-Desktop-projects-radicalize-me-public
 *
 * Exported for unit testing. Kept as a pure function so the matching
 * semantics (exact match vs substring) are unambiguous and regression-testable.
 */
export function encodeClaudeProjectPath(projectPath: string): string {
  // Match Claude Code: every non-alphanumeric char becomes '-'. Must include
  // '.', or worktree cwds (`.../.claude/worktrees/<name>`) encode to a dir the
  // SDK never reads and resume fails with "No conversation found".
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Returns true iff the given Claude projects directory name corresponds
 * exactly to the given project path. Exact match - do NOT substring-match,
 * because a child project's dir name begins with the parent's encoded string.
 */
export function isClaudeDirForProject(dir: string, projectPath: string): boolean {
  return dir === encodeClaudeProjectPath(projectPath)
}

/**
 * Scan for Claude Code sessions associated with a project path.
 *
 * Claude Code stores sessions in <claudeBase>/projects/{encoded-path}/
 * where {encoded-path} is the absolute project path with / and _ replaced by -
 *
 * `claudeBaseDirs` should be the full list of known Claude config roots
 * (e.g. ~/.claude plus every oauth_dir from provider_instances). Defaults to
 * ~/.claude only, which is correct for single-auth setups.
 */
export async function scanClaudeCodeSessions(
  projectPath: string,
  claudeBaseDirs: string[] = [join(homedir(), '.claude')],
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = []
  const seenIds = new Set<string>()

  for (const base of claudeBaseDirs) {
    const claudeDir = join(base, 'projects')
    await scanClaudeProjectsDir(claudeDir, projectPath, sessions, seenIds)
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

async function scanClaudeProjectsDir(
  claudeDir: string,
  projectPath: string,
  sessions: SessionSummary[],
  seenIds: Set<string>,
): Promise<void> {
  // The match is exact (encodeClaudeProjectPath), so target that one directory
  // directly instead of readdir-ing the whole projects folder and scanning
  // every entry once per project.
  const projectDir = join(claudeDir, encodeClaudeProjectPath(projectPath))
  const dirStat = await stat(projectDir).catch(() => null)
  if (!dirStat?.isDirectory()) return

  // Look for sessions index
  const indexPath = join(projectDir, 'sessions-index.json')
  try {
    const indexContent = await readFile(indexPath, 'utf-8')
    const index = JSON.parse(indexContent)

    if (Array.isArray(index)) {
      for (const entry of index) {
        const id: string = entry.id ?? entry.sessionId ?? basename(entry.path ?? '')
        if (seenIds.has(id)) continue
        seenIds.add(id)
        sessions.push({
          id,
          source: 'claude-code',
          title: entry.title ?? entry.summary ?? `Session ${sessions.length + 1}`,
          startedAt: entry.startedAt ?? entry.timestamp ?? Date.now(),
          messageCount: entry.messageCount ?? 0,
          filePath: join(projectDir, entry.path ?? `${entry.id}.jsonl`),
        })
      }
    }
  } catch {
    // No index file - scan for .jsonl files directly
    const files = await readdir(projectDir).catch(() => [])
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const id = file.replace('.jsonl', '')
      if (seenIds.has(id)) continue
      seenIds.add(id)
      const filePath = join(projectDir, file)
      const fileStat = await stat(filePath).catch(() => null)

      // Try to extract title from first user message
      let title = `Session ${sessions.length + 1}`
      try {
        const head = await readHead(filePath, 5000)
        const firstUserMsg = head.split('\n').find((line) => {
          try {
            const obj = JSON.parse(line)
            return obj.type === 'human' || (obj.type === 'user' && obj.message?.content)
          } catch { return false }
        })
        if (firstUserMsg) {
          const obj = JSON.parse(firstUserMsg)
          const content = obj.message?.content
          const text = typeof content === 'string' ? content
            : Array.isArray(content) ? content.find((b: { type?: string; text?: string }) => b.type === 'text')?.text ?? ''
            : ''
          if (text) title = generateTitle(text)
        }
      } catch { /* title extraction failed - use default */ }

      sessions.push({
        id,
        source: 'claude-code',
        title,
        startedAt: fileStat?.mtimeMs ?? Date.now(),
        messageCount: 0,
        filePath,
      })
    }
  }
}

/**
 * Scan for Codex sessions associated with a project path.
 * Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
export async function scanCodexSessions(projectPath: string): Promise<SessionSummary[]> {
  const codexDir = join(homedir(), '.codex', 'sessions')
  const sessions: SessionSummary[] = []

  try {
    await scanCodexDir(codexDir, projectPath, sessions)
  } catch {
    // ~/.codex/sessions doesn't exist
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

// Cache the 2 KB head of each rollout file, keyed by path, so the
// ever-growing Codex history isn't re-read on every scan. Holds the in-flight
// Promise (not the resolved value) so the concurrent per-project scans from
// GET_PROJECTS share one read instead of stampeding the same file N times -
// that stampede OOM'd v0.5.3 on real-world Codex histories. Headers are
// immutable once written, so no mtime invalidation is needed.
const codexHeadCache = new Map<string, Promise<string>>()

const HEAD_BYTES = 2000

// Session files run to tens of MB; read only the head bytes instead of
// readFile-ing the whole file to inspect the first few lines.
async function readHead(fullPath: string, maxBytes: number): Promise<string> {
  const fh = await open(fullPath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    return buf.toString('utf-8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

function getCachedCodexHead(fullPath: string): Promise<string> {
  let head = codexHeadCache.get(fullPath)
  if (!head) {
    head = readHead(fullPath, HEAD_BYTES)
    codexHeadCache.set(fullPath, head)
  }
  return head
}

async function scanCodexDir(
  dir: string,
  projectPath: string,
  sessions: SessionSummary[]
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await scanCodexDir(fullPath, projectPath, sessions)
    } else if (entry.name.endsWith('.jsonl')) {
      // Quick check: read first few lines to see if CWD matches
      try {
        const head = await getCachedCodexHead(fullPath)
        if (!head.includes(projectPath)) continue
        const fileStat = await stat(fullPath).catch(() => null)
        if (!fileStat) continue
        sessions.push({
          id: entry.name.replace('.jsonl', ''),
          source: 'codex',
          title: `Codex ${sessions.length + 1}`,
          startedAt: fileStat.mtimeMs,
          messageCount: 0,
          filePath: fullPath,
        })
      } catch {
        codexHeadCache.delete(fullPath)
        // Skip unreadable files
      }
    }
  }
}

/**
 * Scan for OpenCode sessions associated with a project path.
 * OpenCode sessions are stored as summary files in
 * ~/.opencode/sessions/{encoded-path}/{sessionId}.json
 */
export async function scanOpenCodeSessions(projectPath: string): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = []
  try {
    const opencodeDir = join(homedir(), '.opencode', 'sessions')
    const projectSessionsDir = join(opencodeDir, encodeClaudeProjectPath(projectPath))
    const files = await readdir(projectSessionsDir).catch(() => [])

    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const filePath = join(projectSessionsDir, file)
        const content = await readFile(filePath, 'utf-8')
        const summary = JSON.parse(content)
        sessions.push({
          id: summary.id,
          source: 'opencode',
          title: summary.title,
          startedAt: summary.startedAt,
          messageCount: 0, // Summary file doesn't have this
          filePath: '', // No single file for the whole session
        })
      } catch (err) {
        log.warn(`skipping malformed OpenCode summary ${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    log.warn(`failed to scan OpenCode sessions for ${projectPath}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Scan all sources for a project.
 *
 * `claudeBaseDirs` - every Claude config root to look inside (e.g. ~/.claude
 * plus every oauth_dir from provider_instances). Callers in app.ts build this
 * list from `listOauthDirsForAgent` + `defaultClaudeDir()` so multi-auth
 * sessions show up in the sidebar regardless of which profile wrote them.
 */
export async function scanAllSessions(
  projectPath: string,
  claudeBaseDirs?: string[],
): Promise<SessionSummary[]> {
  const [claude, codex, opencode] = await Promise.all([
    scanClaudeCodeSessions(projectPath, claudeBaseDirs),
    scanCodexSessions(projectPath),
    scanOpenCodeSessions(projectPath),
  ])
  return [...claude, ...codex, ...opencode].sort((a, b) => b.startedAt - a.startedAt)
}

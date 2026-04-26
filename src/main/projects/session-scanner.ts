import { readdir, readFile, stat } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { generateTitle } from '@shared/auto-title'
import type { SessionSummary, SessionSource } from '@shared/types'

/**
 * Claude Code encodes paths by replacing / and _ with -
 * e.g. /Users/tejas/Desktop/projects/radicalize_me_public
 *   -> -Users-tejas-Desktop-projects-radicalize-me-public
 *
 * Exported for unit testing. Kept as a pure function so the matching
 * semantics (exact match vs substring) are unambiguous and regression-testable.
 */
export function encodeClaudeProjectPath(projectPath: string): string {
  return projectPath.replace(/[/_]/g, '-')
}

/**
 * Returns true iff the given Claude projects directory name corresponds
 * exactly to the given project path. Exact match — do NOT substring-match,
 * because a child project's dir name begins with the parent's encoded string.
 */
export function isClaudeDirForProject(dir: string, projectPath: string): boolean {
  return dir === encodeClaudeProjectPath(projectPath)
}

/**
 * Scan for Claude Code sessions associated with a project path.
 *
 * Claude Code stores sessions in ~/.claude/projects/{encoded-path}/
 * where {encoded-path} is the absolute project path with / replaced by -
 * and prefixed with a dash.
 */
export async function scanClaudeCodeSessions(projectPath: string): Promise<SessionSummary[]> {
  const claudeDir = join(homedir(), '.claude', 'projects')
  const sessions: SessionSummary[] = []

  try {
    const dirs = await readdir(claudeDir)

    for (const dir of dirs) {
      // Exact match only — previously used `dir.includes(encoded)` which caused
      // parent projects (e.g. /Users/foo/ssg) to incorrectly pick up sessions
      // from child projects (e.g. /Users/foo/ssg/submodule), since the child
      // dir name begins with the parent's encoded string.
      if (!isClaudeDirForProject(dir, projectPath)) continue

      const projectDir = join(claudeDir, dir)
      const dirStat = await stat(projectDir).catch(() => null)
      if (!dirStat?.isDirectory()) continue

      // Look for sessions index
      const indexPath = join(projectDir, 'sessions-index.json')
      try {
        const indexContent = await readFile(indexPath, 'utf-8')
        const index = JSON.parse(indexContent)

        if (Array.isArray(index)) {
          for (const entry of index) {
            sessions.push({
              id: entry.id ?? entry.sessionId ?? basename(entry.path ?? ''),
              source: 'claude-code',
              title: entry.title ?? entry.summary ?? `Session ${sessions.length + 1}`,
              startedAt: entry.startedAt ?? entry.timestamp ?? Date.now(),
              messageCount: entry.messageCount ?? 0,
              filePath: join(projectDir, entry.path ?? `${entry.id}.jsonl`),
            })
          }
        }
      } catch {
        // No index file — scan for .jsonl files directly
        const files = await readdir(projectDir).catch(() => [])
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue
          const filePath = join(projectDir, file)
          const fileStat = await stat(filePath).catch(() => null)

          // Try to extract title from first user message
          let title = `Session ${sessions.length + 1}`
          try {
            const head = await readFile(filePath, 'utf-8').then((c) => c.slice(0, 5000))
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
                : Array.isArray(content) ? content.find((b: any) => b.type === 'text')?.text ?? ''
                : ''
              if (text) title = generateTitle(text)
            }
          } catch { /* title extraction failed — use default */ }

          sessions.push({
            id: file.replace('.jsonl', ''),
            source: 'claude-code',
            title,
            startedAt: fileStat?.mtimeMs ?? Date.now(),
            messageCount: 0,
            filePath,
          })
        }
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist — that's fine
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
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
        const head = await readFile(fullPath, 'utf-8').then((c) => c.slice(0, 2000))
        if (head.includes(projectPath)) {
          const fileStat = await stat(fullPath).catch(() => null)
          sessions.push({
            id: entry.name.replace('.jsonl', ''),
            source: 'codex',
            title: `Codex ${sessions.length + 1}`,
            startedAt: fileStat?.mtimeMs ?? Date.now(),
            messageCount: 0,
            filePath: fullPath,
          })
        }
      } catch {
        // Skip unreadable files
      }
    }
  }
}

/**
 * Scan all sources for a project.
 */
export async function scanAllSessions(projectPath: string): Promise<SessionSummary[]> {
  const [claude, codex] = await Promise.all([
    scanClaudeCodeSessions(projectPath),
    scanCodexSessions(projectPath),
  ])
  return [...claude, ...codex].sort((a, b) => b.startedAt - a.startedAt)
}

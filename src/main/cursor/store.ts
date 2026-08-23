import Database from 'better-sqlite3'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import type { ChatMessage, SessionSummary } from '@shared/types'
import { workspaceStorageMatchesProject } from './workspace'

type JsonRecord = Record<string, unknown>

interface CursorConversationLocation {
  summary: SessionSummary
  format: 'legacy' | 'global'
  databasePath: string
  composerId: string
  inlineComposer?: JsonRecord
}

export interface LoadedCursorConversation {
  summary: SessionSummary
  messages: ChatMessage[]
}

function cursorUserDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Cursor', 'User')
}

const MAX_CURSOR_RECORD_BYTES = 16 * 1024 * 1024

export function parseCursorJsonValue(
  value: unknown,
  maxBytes = MAX_CURSOR_RECORD_BYTES,
): unknown {
  try {
    if (Buffer.isBuffer(value)) {
      if (value.byteLength > maxBytes) return null
      return JSON.parse(value.toString('utf8'))
    }
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > maxBytes) return null
      return JSON.parse(value)
    }
  } catch {
    return null
  }
  return null
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function timestamp(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function titleOf(composer: JsonRecord): string {
  for (const key of ['name', 'subtitle', 'title']) {
    const value = composer[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return 'Cursor conversation'
}

function array(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => item !== null) : []
}

function inlineBubbles(composer: JsonRecord): JsonRecord[] {
  for (const key of ['fullConversation', 'conversation', 'bubbles']) {
    const bubbles = array(composer[key])
    if (bubbles.length) return bubbles
  }
  const map = record(composer.conversationMap)
  return map ? Object.values(map).map(record).filter((item): item is JsonRecord => item !== null) : []
}

function composerHeaders(composer: JsonRecord): JsonRecord[] {
  const current = array(composer.fullConversationHeadersOnly)
  return current.length ? current : inlineBubbles(composer)
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}

function openReadonly(path: string): Database.Database | null {
  try {
    return new Database(path, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
}

function matchingWorkspaceDirs(projectPath: string, userDir: string): string[] {
  const storageRoot = join(userDir, 'workspaceStorage')
  if (!existsSync(storageRoot)) return []
  try {
    return readdirSync(storageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(storageRoot, entry.name))
      .filter((dir) => workspaceStorageMatchesProject(dir, projectPath))
  } catch {
    return []
  }
}

function legacyLocations(workspaceDirs: string[]): CursorConversationLocation[] {
  const locations: CursorConversationLocation[] = []
  for (const workspaceDir of workspaceDirs) {
    const databasePath = join(workspaceDir, 'state.vscdb')
    const db = openReadonly(databasePath)
    if (!db) continue
    try {
      if (!hasTable(db, 'ItemTable')) continue
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as
        | { value: unknown }
        | undefined
      const data = record(parseCursorJsonValue(row?.value))
      const composers = data ? array(data.allComposers) : []
      for (const composer of composers) {
        const composerId = typeof composer.composerId === 'string' ? composer.composerId : ''
        if (!composerId || composer.isDraft === true) continue
        const headers = composerHeaders(composer)
        locations.push({
          format: 'legacy',
          databasePath,
          composerId,
          inlineComposer: composer,
          summary: {
            id: composerId,
            source: 'cursor',
            title: titleOf(composer),
            startedAt: timestamp(composer.lastUpdatedAt, timestamp(composer.createdAt)),
            messageCount: headers.length,
            filePath: databasePath,
            nativeRole: 'foreground',
          },
        })
      }
    } catch {
      // One malformed legacy database must not hide other Cursor workspaces.
    } finally {
      db.close()
    }
  }
  return locations
}

function globalLocations(workspaceDirs: string[], userDir: string): CursorConversationLocation[] {
  const databasePath = join(userDir, 'globalStorage', 'state.vscdb')
  const db = openReadonly(databasePath)
  if (!db) return []
  try {
    if (!hasTable(db, 'composerHeaders')) return []
    const workspaceIds = new Set(workspaceDirs.map((dir) => basename(dir)))
    if (!workspaceIds.size) return []
    const rows = db.prepare(`
      SELECT composerId, workspaceId, createdAt, lastUpdatedAt,
             isArchived, isSubagent, value
      FROM composerHeaders
    `).all() as Array<{
      composerId: unknown
      workspaceId: unknown
      createdAt: unknown
      lastUpdatedAt: unknown
      isArchived: unknown
      isSubagent: unknown
      value: unknown
    }>
    return rows.flatMap((row): CursorConversationLocation[] => {
      if (typeof row.composerId !== 'string'
        || typeof row.workspaceId !== 'string'
        || !workspaceIds.has(row.workspaceId)
        || row.isSubagent === 1) return []
      const header = record(parseCursorJsonValue(row.value)) ?? {}
      const composerRow = hasTable(db, 'cursorDiskKV')
        ? db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${row.composerId}`) as
          | { value: unknown }
          | undefined
        : undefined
      const composer = record(parseCursorJsonValue(composerRow?.value)) ?? {}
      if (row.isArchived !== 0 && row.isArchived !== null && row.isArchived !== undefined) return []
      return [{
        format: 'global',
        databasePath,
        composerId: row.composerId,
        summary: {
          id: row.composerId,
          source: 'cursor',
          title: titleOf({ ...composer, ...header }),
          startedAt: timestamp(row.lastUpdatedAt, timestamp(row.createdAt)),
          messageCount: composerHeaders(composer).length,
          filePath: databasePath,
          nativeRole: 'foreground',
        },
      }]
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}

function discoverLocations(projectPath: string, userDir: string): CursorConversationLocation[] {
  const workspaceDirs = matchingWorkspaceDirs(projectPath, userDir)
  const preferred = new Map<string, CursorConversationLocation>()
  for (const location of legacyLocations(workspaceDirs)) preferred.set(location.composerId, location)
  for (const location of globalLocations(workspaceDirs, userDir)) preferred.set(location.composerId, location)
  return [...preferred.values()].sort((left, right) => right.summary.startedAt - left.summary.startedAt)
}

function roleOf(bubble: JsonRecord): 'user' | 'assistant' | null {
  if (bubble.type === 1 || bubble.type === 'user' || bubble.type === 'human') return 'user'
  if (bubble.type === 2 || bubble.type === 'assistant' || bubble.type === 'ai') return 'assistant'
  return null
}

function normalizeBubbles(composerId: string, bubbles: JsonRecord[], fallbackTimestamp: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (let index = 0; index < bubbles.length; index += 1) {
    const bubble = bubbles[index]
    const role = roleOf(bubble)
    const content = typeof bubble.text === 'string'
      ? bubble.text
      : typeof bubble.richText === 'string'
        ? bubble.richText
        : ''
    if (!role || !content.trim()) continue
    const bubbleId = typeof bubble.bubbleId === 'string' && bubble.bubbleId
      ? bubble.bubbleId
      : String(index)
    messages.push({
      id: `cursor:${composerId}:${bubbleId}`,
      role,
      content,
      timestamp: timestamp(bubble.createdAt, fallbackTimestamp + index),
    })
  }
  return messages
}

function loadGlobal(location: CursorConversationLocation): ChatMessage[] {
  const db = openReadonly(location.databasePath)
  if (!db) return []
  try {
    const composerRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      .get(`composerData:${location.composerId}`) as { value: unknown } | undefined
    const composer = record(parseCursorJsonValue(composerRow?.value))
    if (!composer) return []
    const inline = inlineBubbles(composer)
    if (inline.length) return normalizeBubbles(location.composerId, inline, location.summary.startedAt)

    const headers = composerHeaders(composer)
    const rows = db.prepare('SELECT key, value FROM cursorDiskKV WHERE key GLOB ?')
      .all(`bubbleId:${location.composerId}:*`) as Array<{ key: string; value: unknown }>
    const bubbles = new Map<string, JsonRecord>()
    for (const row of rows) {
      const bubble = record(parseCursorJsonValue(row.value))
      if (!bubble) continue
      const id = typeof bubble.bubbleId === 'string'
        ? bubble.bubbleId
        : row.key.slice(`bubbleId:${location.composerId}:`.length)
      bubbles.set(id, bubble)
    }
    const ordered = headers.flatMap((header): JsonRecord[] => {
      const id = typeof header.bubbleId === 'string' ? header.bubbleId : ''
      const bubble = bubbles.get(id)
      return bubble ? [{ ...header, ...bubble }] : []
    })
    return normalizeBubbles(location.composerId, ordered, location.summary.startedAt)
  } catch {
    return []
  } finally {
    db.close()
  }
}

export async function scanCursorSessions(
  projectPath: string,
  userDir = cursorUserDir(),
): Promise<SessionSummary[]> {
  return discoverLocations(projectPath, userDir).map((location) => location.summary)
}

export async function loadCursorConversation(
  projectPath: string,
  composerId: string,
  userDir = cursorUserDir(),
): Promise<LoadedCursorConversation | null> {
  const location = discoverLocations(projectPath, userDir)
    .find((candidate) => candidate.composerId === composerId)
  if (!location) return null
  const messages = location.format === 'global'
    ? loadGlobal(location)
    : normalizeBubbles(
      location.composerId,
      inlineBubbles(location.inlineComposer ?? {}),
      location.summary.startedAt,
    )
  return { summary: location.summary, messages }
}

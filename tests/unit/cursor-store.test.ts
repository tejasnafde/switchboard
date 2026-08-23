import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadCursorConversation,
  parseCursorJsonValue,
  scanCursorSessions,
} from '../../src/main/cursor/store'
import { scanAllSessions } from '../../src/main/projects/session-scanner'

const roots: string[] = []

function fixture(): { root: string; userDir: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'sb-cursor-store-'))
  roots.push(root)
  const userDir = join(root, 'User')
  const project = join(root, 'project')
  mkdirSync(join(userDir, 'workspaceStorage'), { recursive: true })
  mkdirSync(project)
  return { root, userDir, project }
}

function workspace(userDir: string, id: string, project: string): string {
  const dir = join(userDir, 'workspaceStorage', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ folder: `file://${project}` }))
  return dir
}

function createTables(path: string): Database.Database {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `)
  return db
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Cursor conversation stores', () => {
  it('bounds JSON records before parsing them', () => {
    expect(parseCursorJsonValue(JSON.stringify({ ok: true }), 32)).toEqual({ ok: true })
    expect(parseCursorJsonValue(JSON.stringify({ text: 'too large' }), 8)).toBeNull()
    expect(parseCursorJsonValue(Buffer.from('{"ok":true}'), 32)).toEqual({ ok: true })
  })

  it('reads an inline legacy workspace composer without exposing another workspace', async () => {
    const { userDir, project } = fixture()
    const matching = workspace(userDir, 'matching', project)
    const other = workspace(userDir, 'other', join(project, 'child'))
    const legacy = createTables(join(matching, 'state.vscdb'))
    const ignored = createTables(join(other, 'state.vscdb'))
    const composer = {
      composerId: 'legacy-1',
      name: 'Legacy conversation',
      createdAt: 100,
      lastUpdatedAt: 200,
      fullConversation: [
        { bubbleId: 'u1', type: 1, text: 'hello', createdAt: 110 },
        { bubbleId: 'a1', type: 2, text: 'hi back', createdAt: 120 },
      ],
    }
    legacy.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('composer.composerData', JSON.stringify({ allComposers: [composer] }))
    ignored.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('composer.composerData', JSON.stringify({ allComposers: [{ ...composer, composerId: 'wrong' }] }))
    legacy.close()
    ignored.close()

    const candidates = await scanCursorSessions(project, userDir)
    expect(candidates).toEqual([expect.objectContaining({
      id: 'legacy-1',
      source: 'cursor',
      title: 'Legacy conversation',
      startedAt: 200,
      messageCount: 2,
    })])

    const loaded = await loadCursorConversation(project, 'legacy-1', userDir)
    expect(loaded?.messages).toEqual([
      expect.objectContaining({ id: 'cursor:legacy-1:u1', role: 'user', content: 'hello', timestamp: 110 }),
      expect.objectContaining({ id: 'cursor:legacy-1:a1', role: 'assistant', content: 'hi back', timestamp: 120 }),
    ])
  })

  it('reads current global headers and ordered per-bubble records', async () => {
    const { userDir, project } = fixture()
    workspace(userDir, 'workspace-hash', project)
    mkdirSync(join(userDir, 'globalStorage'))
    const db = createTables(join(userDir, 'globalStorage', 'state.vscdb'))
    db.exec(`
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        workspaceId TEXT,
        createdAt INTEGER,
        lastUpdatedAt INTEGER,
        isArchived INTEGER,
        isSubagent INTEGER,
        recency INTEGER,
        checkpointAt INTEGER,
        value TEXT
      );
    `)
    db.prepare(`INSERT INTO composerHeaders
      (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('current-1', 'workspace-hash', 1000, 2000, 0, 0, 1, 0, JSON.stringify({ name: 'Current conversation' }))
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'composerData:current-1',
      JSON.stringify({
        composerId: 'current-1',
        fullConversationHeadersOnly: [
          { bubbleId: 'u2', type: 1 },
          { bubbleId: 'a2', type: 2 },
          { bubbleId: 'empty', type: 2 },
          { bubbleId: 'tool', type: 3 },
        ],
      }),
    )
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    insert.run('bubbleId:current-1:a2', JSON.stringify({ bubbleId: 'a2', type: 2, text: 'answer', createdAt: '2200' }))
    insert.run('bubbleId:current-1:u2', JSON.stringify({ bubbleId: 'u2', type: 1, text: 'question', createdAt: '2100' }))
    insert.run('bubbleId:current-1:empty', JSON.stringify({ bubbleId: 'empty', type: 2, text: '' }))
    insert.run('bubbleId:current-1:tool', JSON.stringify({ bubbleId: 'tool', type: 3, text: 'hidden' }))
    db.close()

    const candidates = await scanCursorSessions(project, userDir)
    expect(candidates).toEqual([expect.objectContaining({
      id: 'current-1',
      source: 'cursor',
      title: 'Current conversation',
      startedAt: 2000,
      messageCount: 4,
    })])

    const loaded = await loadCursorConversation(project, 'current-1', userDir)
    expect(loaded?.messages.map(({ id, role, content, timestamp }) => ({ id, role, content, timestamp }))).toEqual([
      { id: 'cursor:current-1:u2', role: 'user', content: 'question', timestamp: 2100 },
      { id: 'cursor:current-1:a2', role: 'assistant', content: 'answer', timestamp: 2200 },
    ])
  })

  it('isolates malformed records and returns an empty result when Cursor is absent', async () => {
    const { userDir, project } = fixture()
    const matching = workspace(userDir, 'matching', project)
    const db = createTables(join(matching, 'state.vscdb'))
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('composer.composerData', '{')
    db.close()

    await expect(scanCursorSessions(project, userDir)).resolves.toEqual([])
    await expect(loadCursorConversation(project, 'missing', userDir)).resolves.toBeNull()
    await expect(scanCursorSessions(project, join(userDir, 'absent'))).resolves.toEqual([])
  })

  it('joins Cursor candidates into the all-provider recovery inventory', async () => {
    const { root, userDir, project } = fixture()
    const matching = workspace(userDir, 'matching', project)
    const db = createTables(join(matching, 'state.vscdb'))
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify({ allComposers: [{ composerId: 'cursor-only', name: 'Cursor only', createdAt: 123 }] }),
    )
    db.close()

    const sessions = await scanAllSessions(
      project,
      [join(root, 'no-claude')],
      [join(root, 'no-codex')],
      userDir,
    )
    expect(sessions).toEqual([expect.objectContaining({ id: 'cursor-only', source: 'cursor' })])
  })
})

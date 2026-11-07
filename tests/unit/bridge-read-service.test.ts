/**
 * The bridge read service on a real migrated database: the allowlist applies
 * before ranking and limits on the FTS and fallback paths, title and message
 * hits merge into one row per root chat, the archive words, an empty index,
 * masked plain snippets, label resolution with ambiguity, and read_chat's
 * cursor (unchanged, paged, expired). The history window is read from the
 * stored rows here; its own masking is covered by the history tests.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createMigratedDb } from './helpers/test-db'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

vi.mock('../../src/main/conversations/history', async () => {
  const db = await import('../../src/main/db/database')
  const mask = await import('../../src/main/db/secret-mask')
  return {
    loadConversationHistoryWindow: async (id: string, request: { limit?: number }) => {
      const messages = db
        .messageRowsToChatMessages(db.threadFamilyIds(id).flatMap((f) => db.getMessagesForConversation(f)))
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((m) => ({ ...m, content: mask.maskStoredText(id, m.content) }))
      return { messages: messages.slice(-(request.limit ?? 50)), total: messages.length }
    },
  }
})

import {
  addProject,
  archiveConversation,
  createConversation,
  listBridgeProjectPolicies,
  removeProject,
  saveBridgeProjectPolicy,
  updateConversationTitle,
} from '../../src/main/db/database'
import { secretRedactor } from '../../src/main/secrets/secret-redactor'
import {
  BridgeReadService,
  READ_CHAT_BUDGET_BYTES,
  plainSnippet,
  type BridgeLiveState,
} from '../../src/main/bridge/read-service'
import { jsonBytes } from '../../src/main/bridge/read-budget'
import {
  bridgeProjectId,
  listBridgeProjectSetup,
  removeBridgeProject,
  setBridgeProjectAllowed,
} from '../../src/main/bridge/allowlist'
import { buildBridgeTools } from '../../src/main/mcp/bridge-tools'
import type { BridgeDeliveryService } from '../../src/main/bridge/delivery-service'
import { defaultBridgeProjectPolicy, emptyBridgeEvidence } from '../../src/shared/bridge'
import { SNIPPET_MARK_CLOSE, SNIPPET_MARK_OPEN } from '../../src/shared/message-search'
import type { PendingBlockingEvent } from '../../src/shared/pending-requests'

const MACHINE = 'hub-test-machine'
const ROOT = mkdtempSync(join(tmpdir(), 'sb-bridge-read-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
const ALLOWED = join(ROOT, 'allowed')
const OTHER = join(ROOT, 'other')
mkdirSync(ALLOWED, { recursive: true })
mkdirSync(OTHER, { recursive: true })

let db: Database.Database
let seq = 0
let live: { status: Map<string, 'running' | 'idle'>; pending: Map<string, PendingBlockingEvent[]> }
let service: BridgeReadService

function insert(id: string, chat: string, content: string, timestamp = 1_000 + seq, role = 'assistant') {
  seq += 1
  db.prepare('INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(
    id,
    chat,
    role,
    content,
    timestamp,
  )
}

function chat(id: string, project: string, title: string) {
  createConversation(id, project, 'claude-code', title)
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.value
}

beforeEach(() => {
  db = createMigratedDb()
  seq = 0
  live = { status: new Map(), pending: new Map() }
  const state: BridgeLiveState = {
    status: (id) => live.status.get(id) ?? null,
    busy: () => false,
    pending: (id) => live.pending.get(id) ?? [],
  }
  service = new BridgeReadService({ live: state, machineId: () => MACHINE })
  addProject(ALLOWED, 'Raves site')
  addProject(OTHER, 'Other')
  setBridgeProjectAllowed(ALLOWED, true, MACHINE)
})

describe('the allowlist', () => {
  it('starts empty, lists the sidebar projects and saves the default policy under the realpath', () => {
    setBridgeProjectAllowed(ALLOWED, false, MACHINE)
    expect(listBridgeProjectSetup(MACHINE).every((p) => !p.allowed)).toBe(true)
    expect(ok(service.listProjects()).projects).toEqual([])
    setBridgeProjectAllowed(ALLOWED, true, MACHINE)
    const [project] = ok(service.listProjects()).projects
    expect(project).toMatchObject({
      project_id: bridgeProjectId(MACHINE, realpathSync.native(ALLOWED)),
      label: 'Raves site',
      machine_id: MACHINE,
      default_mode: 'auto',
      maximum_mode: 'auto',
      actions: { edit: true, checks: true, commit: false, push: false, pr: false, merge: false, deploy: false },
      online: true,
      stale: false,
    })
    expect(JSON.stringify(project)).not.toContain(ROOT)
    expect(project).not.toHaveProperty('canonical_local_root')
  })

  it('refuses a folder that is not a project', () => {
    expect(() => setBridgeProjectAllowed(join(ROOT, 'nowhere'), true, MACHINE)).toThrow(/not a Switchboard project/)
  })

  it('keeps an orphaned policy visible and removable, and serves nothing from it', () => {
    const moved = join(ROOT, 'moved')
    mkdirSync(moved, { recursive: true })
    addProject(moved, 'Moved')
    setBridgeProjectAllowed(moved, true, MACHINE)
    chat('t-moved', moved, 'Moved chat')
    expect(ok(service.listRecentChats({ limit: 20 })).chats.map((c) => c.chat.chat_id)).toEqual(['t-moved'])
    const id = bridgeProjectId(MACHINE, realpathSync.native(moved))
    rmSync(moved, { recursive: true })

    expect(ok(service.listProjects()).projects.map((p) => p.label)).toEqual(['Raves site'])
    expect(ok(service.listRecentChats({ limit: 20 })).chats).toEqual([])
    const orphan = listBridgeProjectSetup(MACHINE).find((p) => p.orphan)
    expect(orphan).toMatchObject({ projectId: id, allowed: true, name: 'Moved' })
    removeBridgeProject(id)
    expect(listBridgeProjectSetup(MACHINE).some((p) => p.orphan)).toBe(false)
  })

  it('drops the policy when the project leaves the sidebar', () => {
    removeProject(ALLOWED)
    expect(listBridgeProjectPolicies()).toEqual([])
  })

  it("ignores another machine's policy", () => {
    saveBridgeProjectPolicy(
      defaultBridgeProjectPolicy({
        project_id: 'p-home',
        label: 'Other',
        machine_id: 'hub-home',
        canonical_local_root: realpathSync.native(OTHER),
      }),
    )
    expect(ok(service.listProjects()).projects.map((p) => p.label)).toEqual(['Raves site'])
  })
})

describe('search_chats', () => {
  it('finds title-only and message-only hits, one row per root chat, with matched_on', () => {
    chat('t-title', ALLOWED, 'Raves website layout')
    chat('t-msg', ALLOWED, 'Untitled')
    chat('t-both', ALLOWED, 'Raves website copy')
    insert('m1', 't-msg', 'the raves website needs a header')
    insert('m2', 't-msg', 'raves website footer too')
    insert('m3', 't-both', 'write the raves website hero')
    // A rotated session of t-msg: its hit is the same root chat.
    db.prepare(
      'INSERT INTO conversations (id, project_path, agent_type, title, sidebar_role) VALUES (?, ?, ?, ?, ?)',
    ).run('rotated', ALLOWED, 'claude-code', 'stale', 'recovery')
    db.prepare('INSERT INTO thread_sessions (thread_id, claude_session_id) VALUES (?, ?)').run('t-msg', 'rotated')
    insert('m4', 'rotated', 'raves website again')

    const result = ok(service.searchChats({ query: 'raves website', limit: 20 }))
    expect(result.chats.map((c) => [c.chat.chat_id, c.matched_on])).toEqual([
      ['t-both', 'both'],
      ['t-title', 'title'],
      ['t-msg', 'message'],
    ])
    expect(result).toMatchObject({ partial: false, unavailable_machines: [], machine_ids: [MACHINE] })
    expect(result.call_id).toMatch(/^bread_/)
    expect(result.observed_at).toMatch(/Z$/)
    const titleRow = result.chats.find((c) => c.matched_on === 'title')!
    expect(titleRow.snippet).toBeNull()
    expect(result.chats.find((c) => c.matched_on === 'message')!.snippet).toContain('raves')
    expect(result.chats[0]).toMatchObject({
      chat: { machine_id: MACHINE },
      project: { label: 'Raves site' },
      machine_id: MACHINE,
      status: 'idle',
    })
  })

  it('applies the allowlist before the limit, on the FTS path and on the fallback path', () => {
    chat('t-allowed', ALLOWED, 'A')
    insert('old', 't-allowed', 'deploy notes', 10)
    for (let i = 0; i < 60; i++) {
      chat(`t-other-${i}`, OTHER, `B${i}`)
      insert(`o${i}`, `t-other-${i}`, 'deploy notes deploy notes', 10_000 + i)
    }
    expect(ok(service.searchChats({ query: 'deploy notes', limit: 1 })).chats.map((c) => c.chat.chat_id)).toEqual([
      't-allowed',
    ])
    db.exec('DROP TABLE messages_fts')
    expect(ok(service.searchChats({ query: 'deploy notes', limit: 1 })).chats.map((c) => c.chat.chat_id)).toEqual([
      't-allowed',
    ])
  })

  it('returns one row per chat before the limit, so a busy chat hides no other', () => {
    chat('t-busy', ALLOWED, 'Busy')
    chat('t-quiet', ALLOWED, 'Quiet')
    for (let i = 0; i < 80; i++) insert(`b${i}`, 't-busy', 'release checklist release checklist', 10_000 + i)
    insert('q1', 't-quiet', 'release checklist', 5)
    expect(
      ok(service.searchChats({ query: 'release checklist', limit: 20 }))
        .chats.map((c) => c.chat.chat_id)
        .sort(),
    ).toEqual(['t-busy', 't-quiet'])
    db.exec('DROP TABLE messages_fts')
    expect(
      ok(service.searchChats({ query: 'release checklist', limit: 20 }))
        .chats.map((c) => c.chat.chat_id)
        .sort(),
    ).toEqual(['t-busy', 't-quiet'])
  })

  it('matches titles after masking, so a saved secret in a title is not a prefix oracle', async () => {
    const value = 'tskey-auth-abcdefgh12345678'
    chat('t-key', ALLOWED, `key ${value}`)
    secretRedactor.add('t-key', 'sec-1', 'TAILSCALE_AUTHKEY', Buffer.from(value))
    try {
      expect(ok(service.searchChats({ query: 'tskey', limit: 20 })).chats).toEqual([])
      const r = await service.readChat({ chat: 'key tskey' })
      expect(r.ok ? 'ok' : r.error.code).toBe('project_not_allowed')
    } finally {
      secretRedactor.clear()
    }
  })

  it('leaves archived chats out unless the query says archive or archived', () => {
    chat('t-arch', ALLOWED, 'Old jitter fix')
    insert('a1', 't-arch', 'jitter fixed')
    archiveConversation('t-arch')
    expect(ok(service.searchChats({ query: 'jitter', limit: 20 })).chats).toEqual([])
    const found = ok(service.searchChats({ query: 'jitter archived', limit: 20 })).chats
    expect(found.map((c) => [c.chat.chat_id, c.matched_on, c.archived])).toEqual([['t-arch', 'both', true]])
  })

  it('answers an empty list on an empty index', () => {
    expect(ok(service.searchChats({ query: 'anything', limit: 20 })).chats).toEqual([])
    expect(ok(service.listRecentChats({ limit: 20 })).chats).toEqual([])
  })

  it('returns a plain snippet of at most 240 characters with saved secrets masked', () => {
    chat('t1', ALLOWED, 'Keys')
    const value = 'tskey-auth-abcdefgh12345678'
    insert('s1', 't1', `${'filler words here '.repeat(10)} the needle token is ${value} ${'more text '.repeat(40)}`)
    secretRedactor.add('t1', 'sec-1', 'TAILSCALE_AUTHKEY', Buffer.from(value))
    try {
      const [row] = ok(service.searchChats({ query: 'needle token', limit: 20 })).chats
      expect(row.snippet).not.toContain(value)
      expect(row.snippet).toContain('[secret TAILSCALE_AUTHKEY]')
      expect(row.snippet!.length).toBeLessThanOrEqual(240)
      expect(row.snippet).not.toMatch(/[\u0002\u0003]/)
    } finally {
      secretRedactor.clear()
    }
    expect(
      plainSnippet({
        snippet: '',
        snippetMarked: `a ${SNIPPET_MARK_OPEN}b${SNIPPET_MARK_CLOSE}\n  c ${'x'.repeat(400)}`,
      }),
    ).toMatch(/^a b c x+\.\.\.$/)
  })
})

describe('list_recent_chats', () => {
  it('orders by stored message time and live activity, not metadata, and resolves a project label', () => {
    chat('t-a', ALLOWED, 'A')
    chat('t-b', ALLOWED, 'B')
    chat('t-c', OTHER, 'C')
    insert('a', 't-a', 'hello', 5_000)
    insert('b', 't-b', 'hello', 6_000)
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(99_999_999_999, 't-a')
    expect(ok(service.listRecentChats({ limit: 20 })).chats.map((c) => c.chat.chat_id)).toEqual(['t-b', 't-a'])
    service.noteEvent({ type: 'content', threadId: 't-a' } as never)
    const chats = ok(service.listRecentChats({ project: 'raves', limit: 1 })).chats
    expect(chats.map((c) => c.chat.chat_id)).toEqual(['t-a'])
    expect(chats[0]).not.toHaveProperty('snippet')
  })

  it('refuses a project that is not allowed', () => {
    const r = service.listRecentChats({ project: 'Other', limit: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('project_not_allowed')
  })

  it('answers ambiguous_target with choices when two allowed projects match', () => {
    const second = join(ROOT, 'raves-two')
    mkdirSync(second, { recursive: true })
    addProject(second, 'Raves app')
    setBridgeProjectAllowed(second, true, MACHINE)
    const r = service.listRecentChats({ project: 'raves', limit: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('ambiguous_target')
      expect((r.error.choices as Array<{ label: string }>).map((c) => c.label).sort()).toEqual([
        'Raves app',
        'Raves site',
      ])
      expect(JSON.stringify(r.error)).not.toContain(ROOT)
    }
  })
})

describe('read_chat', () => {
  beforeEach(() => {
    chat('t1', ALLOWED, 'Raves website')
    insert('u1', 't1', 'make the header', 1_000, 'user')
    insert('r1', 't1', 'done with the header', 2_000)
  })

  it('reads by exact id, by a rotated id and by title, and refuses a chat outside the allowlist', async () => {
    db.prepare(
      'INSERT INTO conversations (id, project_path, agent_type, title, sidebar_role) VALUES (?, ?, ?, ?, ?)',
    ).run('rotated', ALLOWED, 'claude-code', 'stale', 'recovery')
    db.prepare('INSERT INTO thread_sessions (thread_id, claude_session_id) VALUES (?, ?)').run('t1', 'rotated')
    for (const ref of ['t1', 'rotated', { machine_id: MACHINE, chat_id: 't1' }, 'raves website', 'raves']) {
      const snap = ok(await service.readChat({ chat: ref }))
      expect('title' in snap && snap.chat).toEqual({ machine_id: MACHINE, chat_id: 't1' })
    }
    chat('t-other', OTHER, 'Hidden')
    for (const ref of ['t-other', 'Hidden', { machine_id: 'hub-home', chat_id: 't1' }]) {
      const r = await service.readChat({ chat: ref })
      expect(r.ok ? 'ok' : r.error.code).toBe('project_not_allowed')
    }
  })

  it('answers ambiguous_target for a title two chats share', async () => {
    chat('t2', ALLOWED, 'Raves website v2')
    const r = await service.readChat({ chat: 'raves' })
    expect(r.ok ? 'ok' : r.error.code).toBe('ambiguous_target')
    if (!r.ok) expect(r.error.choices).toHaveLength(2)
    // An exact title still picks one.
    expect(ok(await service.readChat({ chat: 'Raves website' }))).toMatchObject({ chat: { chat_id: 't1' } })
  })

  it('returns status, the latest reply, pending requests and placeholders for evidence', async () => {
    live.status.set('t1', 'running')
    live.pending.set('t1', [
      { type: 'question.asked', threadId: 't1', requestId: 'q1', questions: [{ question: 'Which colour?' }] } as never,
    ])
    const snap = ok(await service.readChat({ chat: 't1' }))
    if (!('title' in snap)) throw new Error('expected a snapshot')
    expect(snap.status).toBe('waiting_for_user')
    expect(snap.agent_reply).toMatchObject({ message_id: 'r1', text: 'done with the header', partial: true })
    expect(snap.agent_reply!.at).toBe(new Date(2_000).toISOString())
    expect(snap.pending).toEqual([{ kind: 'question', request_id: 'q1', summary: 'Which colour?' }])
    expect(snap.history.map((h) => h.message_id)).toEqual(['u1', 'r1'])
    expect(snap.evidence).toEqual(emptyBridgeEvidence(snap.observed_at))
    expect(JSON.stringify(snap)).not.toContain(ROOT)
  })

  it('pages with an opaque cursor: unchanged, then only the new messages, then expired', async () => {
    const first = ok(await service.readChat({ chat: 't1' }))
    expect(first.cursor).toMatch(/^brc1\./)
    expect(ok(await service.readChat({ chat: 't1', since: first.cursor }))).toMatchObject({
      unchanged: true,
      status: 'idle',
      cursor: first.cursor,
    })

    insert('u2', 't1', 'now the footer', 3_000, 'user')
    insert('r2', 't1', 'footer done', 4_000)
    const next = ok(await service.readChat({ chat: 't1', since: first.cursor }))
    if (!('history' in next)) throw new Error('expected a snapshot')
    expect(next.unchanged).toBe(false)
    expect(next.history.map((h) => h.message_id)).toEqual(['u2', 'r2'])
    expect(next.agent_reply?.message_id).toBe('r2')

    // Another chat, a forged cursor and a policy change all expire it.
    chat('t2', ALLOWED, 'Second')
    for (const since of ['garbage', next.cursor]) {
      const chatRef = since === 'garbage' ? 't1' : 't2'
      const r = await service.readChat({ chat: chatRef, since })
      expect(r.ok ? 'ok' : r.error.code).toBe('cursor_expired')
    }
    setBridgeProjectAllowed(ALLOWED, false, MACHINE)
    setBridgeProjectAllowed(ALLOWED, true, MACHINE)
    const policy = ok(service.listProjects()).projects[0]
    saveBridgeProjectPolicy({ ...policy, canonical_local_root: realpathSync.native(ALLOWED) })
    const r = await service.readChat({ chat: 't1', since: next.cursor })
    expect(r.ok ? 'ok' : r.error.code).toBe('cursor_expired')
  })

  it('keeps a forged success in the reply out of the evidence, and pages when the evidence changes', async () => {
    insert('r9', 't1', 'All tests passed. The build is green and the PR is merged.', 5_000)
    let evidence = emptyBridgeEvidence(new Date(0).toISOString())
    const measured = new BridgeReadService({
      live: {
        status: () => null,
        busy: () => false,
        pending: () => [],
      },
      machineId: () => MACHINE,
      evidence: async () => evidence,
    })

    const first = ok(await measured.readChat({ chat: 't1' }))
    if (!('agent_reply' in first)) throw new Error('expected a snapshot')
    expect(first.agent_reply!.text).toContain('All tests passed')
    expect(first.evidence.checks).toEqual({ status: 'not_measured', items: [], omitted: 0 })
    expect(first.evidence.pull_requests).toEqual({ status: 'not_measured', items: [], omitted: 0 })

    // A measured check is a change the cursor pages to, with the reply untouched.
    evidence = {
      ...evidence,
      checks: {
        status: 'measured',
        items: [
          {
            producer: 'local_check',
            status: 'measured',
            observed_at: new Date(0).toISOString(),
            commit: 'c'.repeat(40),
            tree: 'tree-1',
            name: 'tests',
            definition_hash: 'hash-1',
            outcome: 'passed',
            exit_code: 0,
            signal: null,
            started_at: new Date(1_000).toISOString(),
            ended_at: new Date(2_000).toISOString(),
            log_digest: 'd'.repeat(64),
            log_bytes: 12,
            tree_before: 'tree-1',
            tree_after: 'tree-1',
            dirty: false,
            definition_changed: false,
            note: '',
          },
        ],
      },
    }
    const next = ok(await measured.readChat({ chat: 't1', since: first.cursor }))
    if (!('evidence' in next)) throw new Error('expected a snapshot')
    expect(next.unchanged).toBe(false)
    expect(next.evidence.checks.status).toBe('measured')
    expect(next.cursor).not.toBe(first.cursor)
    // The same evidence again is unchanged: only the observation time moved.
    expect(ok(await measured.readChat({ chat: 't1', since: next.cursor }))).toMatchObject({ unchanged: true })
  })

  it('leaves every fact not measured when the evidence reader throws', async () => {
    const broken = new BridgeReadService({
      live: { status: () => null, busy: () => false, pending: () => [] },
      machineId: () => MACHINE,
      evidence: () => Promise.reject(new Error('git is gone')),
    })
    const snap = ok(await broken.readChat({ chat: 't1' }))
    if (!('evidence' in snap)) throw new Error('expected a snapshot')
    expect(snap.evidence).toEqual(emptyBridgeEvidence(snap.observed_at))
  })

  it('reports an archive, a rename and a same-length rewrite of the reply as changes', async () => {
    const changes: Array<() => void> = [
      () => archiveConversation('t1'),
      () => updateConversationTitle('t1', 'Raves website, renamed'),
      () => db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('DONE WITH THE HEADER', 'r1'),
    ]
    for (const change of changes) {
      const before = ok(await service.readChat({ chat: 't1' }))
      change()
      const after = ok(await service.readChat({ chat: 't1', since: before.cursor }))
      expect(after.unchanged).toBe(false)
    }
  })
})

describe('the MCP tools', () => {
  it('answer a thrown error with a generic internal_error and no message text', async () => {
    const failing = {
      listProjects: () => {
        throw new Error(`ENOENT: no such file, open '${ROOT}/x.jsonl'`)
      },
    } as unknown as BridgeReadService
    const tools = buildBridgeTools({
      chatId: () => 'c1',
      runtimeMode: () => 'auto',
      service: failing,
      delivery: {} as BridgeDeliveryService,
      enabled: () => true,
    })
    const result = await tools.find((t) => t.name === 'list_projects')!.call({})
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result.content)
    expect(text).toContain('internal_error')
    expect(text).not.toContain(ROOT)
    expect(text).not.toContain('ENOENT')
  })
})

describe("read_chat's size budget", () => {
  const REPORT = Array.from({ length: 4600 }, (_, i) => `line ${i}: what the deepdive found, in plain words`).join('\n')

  beforeEach(() => {
    chat('t1', ALLOWED, 'Raves website')
    insert('u1', 't1', 'make the header', 1_000, 'user')
    insert('r1', 't1', 'done with the header', 2_000)
    chat('big', ALLOWED, 'Roadmap deepdive')
    for (let i = 0; i < 40; i += 1)
      insert(`m${i}`, 'big', `message ${i}: `.padEnd(3000, 'context '), 10_000 + i, i % 2 === 0 ? 'user' : 'assistant')
    insert('report', 'big', REPORT, 90_000)
  })

  it('leaves a short chat whole and marks nothing cut', async () => {
    const snap = ok(await service.readChat({ chat: 't1' }))
    if (!('agent_reply' in snap)) throw new Error('expected a snapshot')
    expect(snap.truncated).toBe(false)
    expect(snap.omitted).toEqual({ history: 0, pending: 0, pull_requests: 0, checks: 0 })
    expect(snap.agent_reply).toMatchObject({
      text: 'done with the header',
      length: 'done with the header'.length,
      offset: 0,
      truncated: false,
      next_offset: null,
    })
    expect(snap.history).toHaveLength(2)
  })

  it('fits a 200 KB reply and a long history, says what it cut and keeps the head and the tail', async () => {
    expect(REPORT.length).toBeGreaterThan(200_000)
    const snap = ok(await service.readChat({ chat: 'big' }))
    if (!('agent_reply' in snap)) throw new Error('expected a snapshot')
    expect(jsonBytes(snap)).toBeLessThanOrEqual(READ_CHAT_BUDGET_BYTES)
    expect(snap.truncated).toBe(true)
    expect(snap.agent_reply).toMatchObject({ message_id: 'report', length: REPORT.length, offset: 0, truncated: true })
    expect(snap.agent_reply!.text).toContain('characters cut ...]')
    expect(snap.agent_reply!.text.startsWith('line 0:')).toBe(true)
    expect(snap.agent_reply!.text.endsWith('in plain words')).toBe(true)
    // The oldest messages gave way first, and the answer says how many.
    expect(snap.history.length).toBeGreaterThan(0)
    expect(snap.omitted.history).toBe(20 - snap.history.length)
    expect(snap.history.at(-1)!.message_id).toBe('report')
  })

  it('pages the rest of the reply in order, under the budget, until nothing is left', async () => {
    const first = ok(await service.readChat({ chat: 'big' }))
    if (!('agent_reply' in first)) throw new Error('expected a snapshot')
    let offset: number | null = first.agent_reply!.next_offset
    expect(offset).toBeGreaterThan(0)
    let read = first.agent_reply!.text.slice(0, offset!)
    let pages = 0
    while (offset !== null) {
      const page = ok(await service.readChat({ chat: 'big', reply_offset: offset }))
      if (!('agent_reply' in page)) throw new Error('expected a snapshot')
      expect(jsonBytes(page)).toBeLessThanOrEqual(READ_CHAT_BUDGET_BYTES)
      expect(page.agent_reply!.offset).toBe(offset)
      // A page is the reply, not the chat: the history is left out and counted.
      expect(page.history).toEqual([])
      expect(page.omitted.history).toBeGreaterThan(0)
      read += page.agent_reply!.text
      offset = page.agent_reply!.next_offset
      pages += 1
      expect(pages).toBeLessThan(40)
    }
    expect(read).toBe(REPORT)
    expect(pages).toBeGreaterThan(1)
  })

  it('answers a page even when nothing changed since the cursor, and refuses a bad offset', async () => {
    const first = ok(await service.readChat({ chat: 'big' }))
    if (!('agent_reply' in first)) throw new Error('expected a snapshot')
    expect(ok(await service.readChat({ chat: 'big', since: first.cursor }))).toMatchObject({ unchanged: true })
    const page = ok(await service.readChat({ chat: 'big', since: first.cursor, reply_offset: 10 }))
    expect(page).toMatchObject({ unchanged: false, agent_reply: { offset: 10 } })
    for (const bad of [-1, 1.5, '4', Number.NaN]) {
      const r = await service.readChat({ chat: 'big', reply_offset: bad })
      expect(r.ok ? 'ok' : r.error.code).toBe('invalid_request')
    }
  })

  it('keeps the newest open requests and counts the rest', async () => {
    live.pending.set(
      'big',
      Array.from(
        { length: 14 },
        (_, i) =>
          ({
            type: 'request.opened',
            requestId: `req-${i}`,
            threadId: 'big',
            toolName: 'Bash',
            detail: `command ${i}`,
          }) as unknown as PendingBlockingEvent,
      ),
    )
    const snap = ok(await service.readChat({ chat: 'big' }))
    if (!('agent_reply' in snap)) throw new Error('expected a snapshot')
    expect(snap.pending.map((p) => p.request_id)).toEqual([
      'req-4',
      'req-5',
      'req-6',
      'req-7',
      'req-8',
      'req-9',
      'req-10',
      'req-11',
      'req-12',
      'req-13',
    ])
    expect(snap.omitted.pending).toBe(4)
    expect(snap.truncated).toBe(true)
  })
})

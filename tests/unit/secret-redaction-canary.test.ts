/**
 * Canary for saved-secret masking (design sections 9 and 11). A value is saved
 * through the real answer path into the real file store, then a fake agent
 * prints it in a tool result, streams it in split text and the provider's
 * transcript holds it. The value must be in no emitted event, no stored row,
 * no FTS row, no log line, no analytics payload and no history window. Only
 * the secret file itself (and the provider's own transcript) may hold it.
 */
import { createMigratedDb } from './helpers/test-db'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { until } from './helpers/wait'

const captured = vi.hoisted(() => ({ logs: [] as string[], analytics: [] as string[] }))

vi.mock('../../src/main/logger', () => {
  const line =
    (level: string, scope: string) =>
    (...args: unknown[]) =>
      captured.logs.push(
        `${level} ${scope} ${args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
      )
  return {
    createMainLogger: (scope: string) => ({
      debug: line('DBG', scope),
      info: line('INF', scope),
      warn: line('WRN', scope),
      error: line('ERR', scope),
    }),
  }
})

vi.mock('../../src/main/analytics', () => ({
  trackAnalyticsEvent: (event: string, properties: unknown) =>
    captured.analytics.push(JSON.stringify({ event, properties })),
}))

vi.mock('../../src/main/notebooks/manager', () => ({
  notebookManager: {
    setPublisher: () => {},
    attach: () => [],
    detach: () => {},
    beginTurn: () => {},
    drainTurnEdits: () => [],
    explainsFileEdit: () => false,
  },
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      ;(args[args.length - 1] as (err: Error) => void)(new Error('git does not run in this test'))
    },
  }
})

const dirs = vi.hoisted(() => ({ claude: '' }))
vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: (id: string) => ({
    id,
    agentType: 'claude-code',
    displayName: id,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [dirs.claude],
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { SecretStore } from '../../src/main/secrets/secret-store'
import { SecretRedactor, secretMask, secretRedactor } from '../../src/main/secrets/secret-redactor'
import { loadConversationHistory, loadConversationHistoryWindow } from '../../src/main/conversations/history'
import { clearJsonlCache } from '../../src/main/agent/jsonl-cache'
import { clearTranscriptIndexMemory } from '../../src/main/agent/transcript-index'
import { userDataDir } from '../../src/main/runtime'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import { SECRET_MASKED_TEXT } from '../../src/shared/agent-secret-request'
import type { BackendHost } from '../../src/main/backend/host'
import type { McpTool } from '../../src/main/mcp/mcp-session'
import type { SwitchboardMcpServer } from '../../src/main/mcp/switchboard-mcp-server'
import type { ProviderAdapter, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'

const SESSION = 'c0ffee00-0000-4000-8000-00000000c4a7'
const TMP = mkdtempSync(join(tmpdir(), 'sb-secret-canary-'))
dirs.claude = join(TMP, 'claude')
afterAll(() => {
  // The chat folders are 0300: open them so the tree can be removed.
  const secrets = join(TMP, 'secrets')
  for (const name of readdirSafe(secrets)) chmodSync(join(secrets, name), 0o700)
  rmSync(TMP, { recursive: true, force: true })
})

/** A folder's entries, none when it was never made. */
function readdirSafe(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : []
}

class FakeHost implements BackendHost {
  readonly events: RuntimeEvent[] = []
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(channel: string, event: unknown): void {
    if (channel === ProviderChannels.EVENT) this.events.push(event as RuntimeEvent)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class FakeAgent implements ProviderAdapter {
  readonly provider = 'claude' as const
  emit: (e: RuntimeEvent) => void = () => {}
  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.emit = onEvent
    return {
      threadId: opts.threadId,
      provider: 'claude',
      status: 'ready',
      runtimeMode: opts.runtimeMode ?? 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(threadId: string): Promise<void> {
    this.emit({ type: 'turn.completed', threadId })
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

function writeTranscript(canary: string): void {
  const dir = join(dirs.claude, 'projects', '-repo-canary')
  mkdirSync(dir, { recursive: true })
  const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 0, 0, s)).toISOString()
  const lines = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'read the key' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: at(1),
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `echo ${canary}` } }],
      },
    },
    {
      type: 'user',
      uuid: 'r1',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: canary }] },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: at(3),
      message: { content: [{ type: 'text', text: `The key is ${canary}.` }] },
    },
  ]
  writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

/** Every file under `dir`, as text. */
function filesUnder(dir: string): string[] {
  return readdirSafe(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [readFileSync(path, 'latin1')]
  })
}

let registry: ProviderRegistry | null = null

beforeEach(async () => {
  process.env.SB_AGENT_SECRET_REQUEST = '1'
  captured.logs.length = 0
  captured.analytics.length = 0
  await clearTranscriptIndexMemory()
  clearJsonlCache()
})

afterEach(async () => {
  delete process.env.SB_AGENT_SECRET_REQUEST
  await registry?.stopAll()
  registry = null
  secretRedactor.clear()
})

describe('saved secret canary', () => {
  it('leaves the value only in the secret file', async () => {
    const canary = `sbcanary_${randomBytes(12).toString('hex')}`
    const forms = [canary, Buffer.from(canary).toString('base64').replace(/=+$/, '')]
    const db = createMigratedDb()
    db.exec("INSERT INTO projects (path, name) VALUES ('/repo', 'repo')")
    db.prepare("INSERT INTO conversations (id, project_path, agent_type) VALUES (?, '/repo', 'claude-code')").run(
      SESSION,
    )
    const root = join(TMP, 'secrets')
    const store = new SecretStore({ root, excludeFromBackup: () => {} })
    const host = new FakeHost()
    const agent = new FakeAgent()
    let tools: () => McpTool[] = () => []
    const mcp = {
      open: async (_threadId: string, list: () => McpTool[]) => {
        tools = list
        return { command: 'node', args: [], env: {} }
      },
      close: () => {},
    } as unknown as SwitchboardMcpServer
    registry = new ProviderRegistry(
      host,
      new Map([['claude', agent]]),
      undefined,
      undefined,
      mcp,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      store,
    )
    registry.registerIpcHandlers()
    await host.invoke(ProviderChannels.START_SESSION, { threadId: SESSION, provider: 'claude', cwd: TMP })

    const asked = await tools()
      .find((t) => t.name === 'request_secret')!
      .call({ name: 'CANARY_TOKEN', title: 'Canary', instructions: 'Paste the canary.' })
    const cardId = /card (sbsec_\S+)\)/.exec(asked.content[0].text)![1]
    expect(registry.answerAgentSecret(SESSION, cardId, { save: canary })).toEqual({ ok: true })
    await until(() => expect(host.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' })))
    host.events.length = 0

    // The agent cats the file, prints the value, and streams it split across deltas.
    agent.emit({ type: 'status', threadId: SESSION, status: 'running', newTurn: true })
    agent.emit({
      type: 'tool.started',
      threadId: SESSION,
      toolId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'cat "$SWITCHBOARD_SECRETS_DIR/CANARY_TOKEN"' },
    })
    agent.emit({ type: 'tool.completed', threadId: SESSION, toolId: 'toolu_1', output: `${canary}\n` })
    const text = `The key is ${canary}, encoded ${forms[1]}.`
    const stream = (messageId: string, parts: string[]) => {
      for (const part of parts)
        agent.emit({ type: 'content', threadId: SESSION, messageId, text: part, append: true, streamKind: 'assistant' })
    }
    const deltas: string[] = []
    for (let i = 0; i < text.length; i += 7) deltas.push(text.slice(i, i + 7))
    stream('msg_1', deltas)
    agent.emit({ type: 'error', threadId: SESSION, message: `failed near ${canary}` })
    agent.emit({ type: 'turn.completed', threadId: SESSION })
    // A second turn whose first hit (and so its notice row, posted
    // mid-stream) shares a delta with the start of another copy.
    agent.emit({ type: 'status', threadId: SESSION, status: 'running', newTurn: true })
    stream('msg_2', [`Again ${canary} and ${canary.slice(0, 12)}`, `${canary.slice(12)} end.`])
    agent.emit({ type: 'turn.completed', threadId: SESSION })
    await until(() => expect(host.events.at(-1)?.type).toBeDefined())
    writeTranscript(canary)

    // Emitted events: masked, and the streamed text folds to the masked sentence.
    const emitted = JSON.stringify(host.events)
    for (const form of forms) expect(emitted).not.toContain(form)
    const streamed = host.events
      .filter((e) => e.type === 'content' && e.messageId === 'msg_1')
      .map((e) => (e as { text: string }).text)
      .join('')
    const mask = secretMask('CANARY_TOKEN')
    expect(streamed).toBe(`The key is ${mask}, encoded ${mask}.`)
    const second = host.events
      .filter((e) => e.type === 'content' && e.messageId === 'msg_2')
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(second).toBe(`Again ${mask} and ${mask} end.`)
    expect(emitted).not.toContain(canary.slice(0, 12))

    // One notice row per turn, stored and published.
    const notices = db
      .prepare("SELECT content FROM messages WHERE role = 'system' AND content = ?")
      .all(SECRET_MASKED_TEXT) as unknown[]
    expect(notices).toHaveLength(2)
    expect(host.events.filter((e) => e.type === 'approval.result' && e.content === SECRET_MASKED_TEXT)).toHaveLength(2)

    // Stored rows and the search index.
    const rows = JSON.stringify(db.prepare('SELECT * FROM messages').all())
    const fts = JSON.stringify(db.prepare('SELECT content FROM messages_fts').all())
    expect(rows).toContain(secretMask('CANARY_TOKEN'))
    for (const form of forms) {
      expect(rows).not.toContain(form)
      expect(fts).not.toContain(form)
    }
    expect(db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(canary)).toEqual({
      n: 0,
    })

    // History: the full read (export, fork anchors, handoff) and a phone window.
    const full = await loadConversationHistory(SESSION, '/repo')
    const window = await loadConversationHistoryWindow(SESSION, { limit: 200 })
    const lookup = await loadConversationHistoryWindow(SESSION, { throughId: 'a2' })
    for (const out of [full.messages, full.forkMessages, window.messages, lookup.messages]) {
      const json = JSON.stringify(out)
      expect(json).toContain(secretMask('CANARY_TOKEN'))
      for (const form of forms) expect(json).not.toContain(form)
    }
    // The transcript index on disk holds offsets and hashes, never text.
    for (const file of filesUnder(join(userDataDir(), 'data', 'transcript-index')))
      for (const form of forms) expect(file).not.toContain(form)

    // Logs and analytics.
    expect(captured.logs.some((l) => l.includes('saved secret masked'))).toBe(true)
    for (const form of forms) {
      expect(captured.logs.join('\n')).not.toContain(form)
      expect(captured.analytics.join('\n')).not.toContain(form)
    }

    // The secret file is the one place that holds it.
    const dirId = (db.prepare('SELECT dir_id FROM agent_secret_dirs').get() as { dir_id: string }).dir_id
    expect(readFileSync(join(root, dirId, 'CANARY_TOKEN'), 'utf8')).toBe(canary)

    // A restart reads the live file back and masks again.
    const restarted = new SecretRedactor()
    const again = new SecretStore({ root, excludeFromBackup: () => {}, redactor: restarted })
    again.start()
    expect(restarted.redactText(SESSION, `x ${canary}`)).toBe(`x ${secretMask('CANARY_TOKEN')}`)
    again.stop()
    expect(restarted.any()).toBe(false)

    // A message the user queued: the ledger keeps it as typed for delivery,
    // the event and the list show it masked.
    host.events.length = 0
    const ledger = (registry as unknown as { queuedTurns: { expect(id: string, text: string, at: number): void } })
      .queuedTurns
    ledger.expect('q_canary', `queued ${canary}`, 1)
    agent.emit({ type: 'turn.queued', threadId: SESSION, messageId: 'q_canary' })
    await until(() => expect(host.events).toContainEqual(expect.objectContaining({ type: 'turn.queued' })))
    for (const out of [host.events, registry.listQueuedTurns(SESSION)]) {
      expect(JSON.stringify(out)).toContain(`queued ${mask}`)
      expect(JSON.stringify(out)).not.toContain(canary)
    }

    // Delete now drops the value from memory.
    const listed = registry.listAgentSecrets(SESSION)
    if (!listed.ok) throw new Error(listed.message)
    expect(registry.deleteAgentSecret(SESSION, listed.secrets[0].id)).toEqual({ ok: true })
    expect(secretRedactor.any()).toBe(false)
  })
})

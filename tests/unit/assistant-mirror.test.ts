/**
 * Live assistant replies must reach SQLite, not just the provider's own
 * transcript file. Claude Code prunes and rotates those files, so a reply that
 * lived only there could become unrecoverable. The registry folds `content`
 * deltas per turn and mirrors them on turn.completed (and on a mid-turn stop,
 * where no turn.completed is coming).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

const saved: Array<{ id: string; conversationId: string; role: string; content: string }> = []
const savedAt: Array<number | undefined> = []
const activity: Array<{ id: string; conversationId: string; timestamp: number; toolCalls?: unknown; fileDiff?: { status: string } }> = []
const statusLines: Array<{ id: string; line: string }> = []
vi.mock('../../src/main/db/database', () => ({
  setConversationStatusLine: (id: string, line: string) => { statusLines.push({ id, line }) },
  saveActivityMessageIfAbsent: (row: (typeof activity)[number]) => {
    activity.push(row)
    return true
  },
  recordThreadSession: () => {},
  // Claude rotated this thread's session id; the root conversation is t1.
  resolveRootThreadId: (id: string) => (id === 'rotated-session' ? 't1' : id),
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: (
    id: string, conversationId: string, role: string, content: string,
    _images?: string, _displayBody?: string, timestamp?: number,
  ) => {
    saved.push({ id, conversationId, role, content })
    savedAt.push(timestamp)
    return true
  },
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import type { RuntimeEvent, RuntimeTaskNotificationEvent } from '../../src/shared/provider-events'
import { storedToolText, STORED_TOOL_TEXT_MAX_CHARS } from '../../src/shared/turn-activity'
import { storedTaskNoticeId } from '../../src/shared/synthetic-message'

/** Drives `publish` directly - the mirror is a property of the event stream. */
const emitted: string[] = []
function makeRegistry(): { publish: (e: RuntimeEvent) => void; registry: ProviderRegistry } {
  const host = { handle: () => {}, emit: (channel: string) => { emitted.push(channel) }, on: () => {} }
  const registry = new ProviderRegistry(host as never)
  const publish = (e: RuntimeEvent) => (registry as unknown as {
    publish: (e: RuntimeEvent) => void
  }).publish(e)
  return { publish, registry }
}

const content = (threadId: string, messageId: string, text: string, append?: boolean): RuntimeEvent => ({
  type: 'content', threadId, messageId, text, append, streamKind: 'assistant',
} as RuntimeEvent)

const turnEnd = (threadId: string): RuntimeEvent => ({ type: 'turn.completed', threadId } as RuntimeEvent)

describe('live assistant mirror', () => {
  beforeEach(() => { saved.length = 0; savedAt.length = 0; activity.length = 0; statusLines.length = 0; emitted.length = 0 })

  it('persists the folded reply once the turn completes', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'Hello'))
    publish(content('t1', 'm1', ' world', true))
    expect(saved).toHaveLength(0)

    publish(turnEnd('t1'))
    expect(saved).toEqual([
      { id: 'm1', conversationId: 't1', role: 'assistant', content: 'Hello world' },
    ])
  })

  it('stores the turn digest as the status line, without the tags', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'Done. <agent_digest>Tests pass, PR open</agent_digest>'))
    publish(content('t1', 'm2', 'Anything else?'))
    publish(turnEnd('t1'))
    expect(statusLines).toEqual([{ id: 't1', line: 'Tests pass, PR open' }])
    expect(emitted).toContain('app:conversations-changed')
  })

  it('keeps the stored status line when a stop flushes a half-finished turn', () => {
    const { publish, registry } = makeRegistry()
    publish(content('t1', 'm1', 'Halfway through the'))
    ;(registry as unknown as { flushTurnMirror: (id: string, completed: boolean) => void }).flushTurnMirror('t1', false)
    expect(saved.map((m) => m.content)).toEqual(['Halfway through the'])
    expect(statusLines).toHaveLength(0)
    expect(emitted).not.toContain('app:conversations-changed')
  })

  it('falls back to the plain-text preview when the turn has no digest', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'Fixed **the** `login` bug'))
    publish(turnEnd('t1'))
    expect(statusLines).toEqual([{ id: 't1', line: 'Fixed the login bug' }])
  })

  it('stores nothing for a turn with no assistant text', () => {
    const { publish } = makeRegistry()
    publish(turnEnd('t1'))
    expect(statusLines).toHaveLength(0)
  })

  it('does not mirror reasoning or plan streams', () => {
    const { publish } = makeRegistry()
    publish({ type: 'content', threadId: 't1', messageId: 'r1', text: 'thinking', streamKind: 'reasoning' } as RuntimeEvent)
    publish(turnEnd('t1'))
    expect(saved).toHaveLength(0)
  })

  it('skips a message that streamed only whitespace', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', '   '))
    publish(turnEnd('t1'))
    expect(saved).toHaveLength(0)
  })

  it('keeps threads separate so one turn end does not flush another', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'from one'))
    publish(content('t2', 'm2', 'from two'))
    publish(turnEnd('t1'))
    expect(saved).toEqual([
      { id: 'm1', conversationId: 't1', role: 'assistant', content: 'from one' },
    ])
  })

  it('does not re-persist a flushed turn when a later turn ends', () => {
    const { publish } = makeRegistry()
    publish(content('t1', 'm1', 'first'))
    publish(turnEnd('t1'))
    publish(turnEnd('t1'))
    expect(saved).toHaveLength(1)
  })

  it('stamps each message with its last chunk, not the turn end', () => {
    // A reload sorts by this timestamp. Stamping the whole turn at its end put
    // interim text below the final answer after a chat switch.
    vi.useFakeTimers()
    try {
      const { publish } = makeRegistry()
      vi.setSystemTime(1_000)
      publish(content('t1', 'interim', 'Looking'))
      vi.setSystemTime(90_000)
      publish(content('t1', 'interim', ' around', true))
      vi.setSystemTime(200_000)
      publish(content('t1', 'final', 'Done'))
      vi.setSystemTime(300_000)
      publish(turnEnd('t1'))
      expect(saved.map((s) => s.id)).toEqual(['interim', 'final'])
      expect(savedAt).toEqual([90_000, 200_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('mirrors each tool call with its input, output and start time', () => {
    // The renderer never saves tool rows, and only Claude's transcript keeps
    // them, so without this a reopened Codex or OpenCode turn lost them.
    vi.useFakeTimers()
    try {
      const { publish } = makeRegistry()
      vi.setSystemTime(1_000)
      publish({ type: 'tool.started', threadId: 't1', toolId: 'call_1', toolName: 'Bash', input: { command: 'ls' } })
      vi.setSystemTime(2_000)
      // Codex announces a file change on item/started and again on item/completed.
      publish({ type: 'tool.started', threadId: 't1', toolId: 'call_1', toolName: 'Bash', input: { command: 'ls' } })
      publish({ type: 'tool.completed', threadId: 't1', toolId: 'call_1', output: 'a.ts' })
      expect(activity).toHaveLength(0)
      publish(turnEnd('t1'))
      expect(activity).toEqual([{
        id: 'tool_t1:call_1',
        conversationId: 't1',
        timestamp: 1_000,
        toolCalls: [{ id: 'call_1', name: 'Bash', input: '{\n  "command": "ls"\n}', output: 'a.ts' }],
      }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stores a capped copy of a long tool input, as with the output', () => {
    const { publish } = makeRegistry()
    const long = 'x'.repeat(STORED_TOOL_TEXT_MAX_CHARS * 4)
    publish({ type: 'tool.started', threadId: 't1', toolId: 'edit_1', toolName: 'Edit', input: long })
    publish({ type: 'tool.completed', threadId: 't1', toolId: 'edit_1', output: long })
    publish(turnEnd('t1'))
    const [call] = activity[0].toolCalls as Array<{ input: string; output: string }>
    expect(call.input).toBe(storedToolText(long))
    expect(call.output).toBe(storedToolText(long))
    expect(call.input.length).toBeLessThan(STORED_TOOL_TEXT_MAX_CHARS + 100)
  })

  it('mirrors a changed-file card as it is published, and skips an oversized one', async () => {
    const { publish, registry } = makeRegistry()
    const edit = (relPath: string, newContent: string) => ({
      type: 'file.edited' as const, threadId: 't1', turnId: 'ab-1', fileEditId: `ab-1:${relPath}`,
      repoRoot: '/repo', relPath, changeKind: 'modify' as const, oldContent: 'old', newContent,
    })
    ;(registry as unknown as { checkpoints: unknown }).checkpoints = {
      finishTurn: async () => [edit('a.ts', 'new'), edit('huge.bin', 'x'.repeat(3 * 1024 * 1024))],
      clear: () => {},
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(5_000)
      publish(turnEnd('t1'))
      // The diff finishes later; a message sent meanwhile must still sort after the cards.
      vi.setSystemTime(9_000)
      await vi.waitFor(() => expect(activity).toHaveLength(1))
    } finally {
      vi.useRealTimers()
    }
    expect(activity[0]).toMatchObject({
      id: 'filediff_ab-1:a.ts',
      conversationId: 't1',
      timestamp: 5_000,
      fileDiff: { relPath: 'a.ts', oldContent: 'old', newContent: 'new', status: 'pending' },
    })
  })
})

describe('live task notice mirror', () => {
  beforeEach(() => { saved.length = 0; savedAt.length = 0 })

  const notice = (overrides: Partial<RuntimeTaskNotificationEvent> = {}): RuntimeEvent => ({
    type: 'task.notification', threadId: 't1', messageId: 'task_u1', taskId: 'b1',
    status: 'failed', summary: 'Build failed', outputFile: '/tmp/b1.output', at: 1_000, ...overrides,
  })

  it('stores the notice as its transcript text, at its own time', () => {
    const { publish } = makeRegistry()
    publish(notice())
    expect(saved).toEqual([{
      id: storedTaskNoticeId('t1', 'task_u1'),
      conversationId: 't1',
      role: 'user',
      content: '<task-notification>\n<task-id>b1</task-id>\n<output-file>/tmp/b1.output</output-file>\n<status>failed</status>\n<summary>Build failed</summary>\n</task-notification>',
    }])
    expect(savedAt).toEqual([1_000])
  })

  it('keeps every notice one task reports, and one row per replayed notice', () => {
    const { publish } = makeRegistry()
    publish(notice({ messageId: 'task_u1', status: 'completed', summary: 'Monitor event: "deploy"' }))
    publish(notice({ messageId: 'task_u2', status: 'completed', summary: 'Monitor "deploy" stream ended', at: 2_000 }))
    publish(notice({ messageId: 'task_u2', status: 'completed', summary: 'Monitor "deploy" stream ended', at: 2_000 }))
    // The replay reaches the store under the same id, where INSERT OR IGNORE drops it.
    expect(saved.map((row) => row.id)).toEqual([
      storedTaskNoticeId('t1', 'task_u1'),
      storedTaskNoticeId('t1', 'task_u2'),
      storedTaskNoticeId('t1', 'task_u2'),
    ])
  })

  it('stores a notice from a rotated session id under the root conversation', () => {
    const { publish } = makeRegistry()
    publish(notice({ threadId: 'rotated-session' }))
    expect(saved).toEqual([expect.objectContaining({ id: storedTaskNoticeId('t1', 'task_u1'), conversationId: 't1' })])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { mergeConversationMessages } from '../../src/main/agent/dedupe-messages'
import { reduceProviderEvent } from '../../src/renderer/components/chat/provider-event-reducer'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { flushQueue, resetQueue, threadKey, useChatStore } from '../../apps/mobile/src/stores/chat'
import { historyToItems } from '../../apps/mobile/src/lib/thread-history'
import { splitSyntheticUserText, storedTaskNoticeId, taskNotificationText } from '../../src/shared/synthetic-message'
import type { RuntimeEvent, RuntimeTaskNotificationEvent } from '../../src/shared/provider-events'
import type { ChatMessage } from '../../src/shared/types'

vi.mock('../../src/renderer/services/notifications', () => ({ notifyTurnCompleted: async () => {} }))

// Recorded from a live SDK session (claude-agent-sdk SDKTaskNotificationMessage).
const SDK_MESSAGE = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'bd5t7u1q8',
  tool_use_id: 'toolu_01WjAcjk2YZSSgxKidw1G35C',
  status: 'failed',
  output_file: '/private/tmp/claude-501/proj/sess/tasks/bd5t7u1q8.output',
  summary: 'Background command "Re-run city tier analysis" failed with exit code 144',
  usage: { total_tokens: 0, tool_uses: 0, duration_ms: 4210 },
  uuid: '6f1c2a0e-4b7d-4f9e-9a51-0c3e2d1b8a77',
  session_id: 'sess',
}

// The user line the CLI writes for the same notice, as a reload reads it.
const TRANSCRIPT_TEXT = '<task-notification>\n<task-id>bd5t7u1q8</task-id>\n<tool-use-id>toolu_01WjAcjk2YZSSgxKidw1G35C</tool-use-id>\n'
  + '<output-file>/private/tmp/claude-501/proj/sess/tasks/bd5t7u1q8.output</output-file>\n<status>failed</status>\n'
  + '<summary>Background command "Re-run city tier analysis" failed with exit code 144</summary>\n</task-notification>'

function dispatch(msg: object): RuntimeEvent[] {
  const onEvent = vi.fn()
  const active = {
    session: { threadId: 'thread-1', sessionId: 'sess' },
    query: null,
    onEvent,
    watchdog: { activity: () => {} },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(new ClaudeAdapter() as any).handleSDKMessage('thread-1', active, msg)
  return onEvent.mock.calls.map((c) => c[0] as RuntimeEvent).filter((e) => e.type === 'task.notification')
}

function liveEvent(): RuntimeTaskNotificationEvent {
  return dispatch(SDK_MESSAGE)[0] as RuntimeTaskNotificationEvent
}

describe('Claude system/task_notification', () => {
  it('maps to a task.notification event with the transcript fields', () => {
    expect(liveEvent()).toEqual({
      type: 'task.notification',
      threadId: 'thread-1',
      messageId: `task_${SDK_MESSAGE.uuid}`,
      taskId: 'bd5t7u1q8',
      status: 'failed',
      summary: SDK_MESSAGE.summary,
      outputFile: SDK_MESSAGE.output_file,
      at: expect.any(Number),
    })
  })

  it('skips housekeeping tasks the transcript never records', () => {
    expect(dispatch({ ...SDK_MESSAGE, skip_transcript: true })).toEqual([])
  })

  it('splits into the same row as the transcript line', () => {
    expect(splitSyntheticUserText(taskNotificationText(liveEvent()))).toEqual(splitSyntheticUserText(TRANSCRIPT_TEXT))
  })
})

describe('live row vs reload', () => {
  const T = 'thread-1'
  // The CLI stamps the transcript line when a turn consumes the notice, just after it.
  const transcriptLine = (at: number): ChatMessage => ({ id: 'jsonl-uuid', role: 'user', content: TRANSCRIPT_TEXT, timestamp: at + 70 })

  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    useAgentStore.getState().addSession({ id: T, type: 'claude', status: 'running', title: 'c', projectPath: '/p' })
  })

  it('desktop: a replay lands on the same row and a reload replaces it', () => {
    const event = liveEvent()
    reduceProviderEvent(event, { streamingEnabled: true, coalescer: null })
    reduceProviderEvent(event, { streamingEnabled: true, coalescer: null })
    const messages = () => useAgentStore.getState().sessions[0].messages
    expect(messages()).toHaveLength(1)
    expect(splitSyntheticUserText(messages()[0].content)).toEqual(splitSyntheticUserText(TRANSCRIPT_TEXT))

    // The live copy is never mirrored to SQLite, so history is the transcript alone.
    const reloaded = transcriptLine(event.at)
    const history = mergeConversationMessages([reloaded], [])
    useAgentStore.getState().setMessages(T, history)
    expect(messages()).toEqual([reloaded])

    // A resume replay after the reload does not put it back beside the transcript row.
    reduceProviderEvent(event, { streamingEnabled: true, coalescer: null })
    expect(messages()).toEqual([reloaded])
    // The same subagent finishing again later is a new notice.
    reduceProviderEvent({ ...event, messageId: 'task_later', at: event.at + 600_000 }, { streamingEnabled: true, coalescer: null })
    expect(messages().map((m) => m.id)).toEqual(['jsonl-uuid', 'task_later'])
  })

  it('phone: renders the same synthetic part, once', () => {
    resetQueue()
    useChatStore.setState({ threads: {}, activeKey: null })
    const event = liveEvent()
    useChatStore.getState().ingest('c1', event)
    useChatStore.getState().ingest('c1', event)
    flushQueue()
    const items = useChatStore.getState().threads[threadKey('c1', T)].items
    expect(items).toEqual([{ kind: 'synthetic', id: event.messageId, part: splitSyntheticUserText(TRANSCRIPT_TEXT)!.parts[0] }])
  })

  it('phone: a replay after a re-seed does not add it beside the history row', () => {
    resetQueue()
    useChatStore.setState({ threads: {}, activeKey: null })
    const event = liveEvent()
    const key = threadKey('c1', T)
    useChatStore.getState().seedItems(key, historyToItems([transcriptLine(event.at)]))
    useChatStore.getState().ingest('c1', event)
    flushQueue()
    expect(useChatStore.getState().threads[key].items.map((i) => i.id)).toEqual(['h-jsonl-uuid-s0'])
  })

  // The transcript parser trims tag values, so a padded live summary still matches.
  const padded = () => ({ ...liveEvent(), summary: `${SDK_MESSAGE.summary}  \n` })
  // A row stamped later than the window is a different notice, even with equal fields.
  const tooLate = (at: number): ChatMessage => ({ ...transcriptLine(at), timestamp: at + 6_000 })

  it('desktop: matches a padded summary, and not a row outside the window', () => {
    const messages = () => useAgentStore.getState().sessions[0].messages.map((m) => m.id)
    const event = padded()
    useAgentStore.getState().setMessages(T, [transcriptLine(event.at)])
    reduceProviderEvent(event, { streamingEnabled: true, coalescer: null })
    expect(messages()).toEqual(['jsonl-uuid'])

    useAgentStore.getState().setMessages(T, [tooLate(event.at)])
    reduceProviderEvent(event, { streamingEnabled: true, coalescer: null })
    expect(messages()).toEqual(['jsonl-uuid', event.messageId])
  })

  it('phone: matches a padded summary, and not a row outside the window', () => {
    const event = padded()
    const ids = (history: ChatMessage) => {
      resetQueue()
      useChatStore.setState({ threads: {}, activeKey: null })
      const key = threadKey('c1', T)
      useChatStore.getState().seedItems(key, historyToItems([history]))
      useChatStore.getState().ingest('c1', event)
      flushQueue()
      return useChatStore.getState().threads[key].items.map((i) => i.id)
    }
    expect(ids(transcriptLine(event.at))).toEqual(['h-jsonl-uuid-s0'])
    expect(ids(tooLate(event.at))).toEqual(['h-jsonl-uuid-s0', event.messageId])
  })
})

describe('stored notice across a reload', () => {
  const T = 'thread-1'
  const transcriptLine = (at: number): ChatMessage => ({ id: 'jsonl-uuid', role: 'user', content: TRANSCRIPT_TEXT, timestamp: at + 70 })
  // What the registry writes for the live event (see the assistant-mirror test).
  const stored = (event: RuntimeTaskNotificationEvent): ChatMessage => ({
    id: storedTaskNoticeId(T, event.messageId), role: 'user', content: taskNotificationText(event), timestamp: event.at,
  })
  const ctx = { streamingEnabled: true, coalescer: null }

  beforeEach(() => {
    useAgentStore.setState({ sessions: [], activeSessionId: null })
    useAgentStore.getState().addSession({ id: T, type: 'claude', status: 'running', title: 'c', projectPath: '/p' })
    resetQueue()
    useChatStore.setState({ threads: {}, activeKey: null })
  })

  const desktopAfterReload = (history: ChatMessage[], event: RuntimeTaskNotificationEvent) => {
    useAgentStore.getState().setMessages(T, history)
    reduceProviderEvent(event, ctx)
    return useAgentStore.getState().sessions[0].messages
  }
  const phoneAfterReseed = (history: ChatMessage[], event: RuntimeTaskNotificationEvent) => {
    const key = threadKey('c1', T)
    useChatStore.getState().ingest('c1', event)
    flushQueue()
    useChatStore.getState().seedItems(key, historyToItems(history))
    useChatStore.getState().ingest('c1', event)
    flushQueue()
    return useChatStore.getState().threads[key].items
  }

  it('keeps a notice the transcript never recorded, as the same row, once', () => {
    const event = liveEvent()
    const history = mergeConversationMessages([], [stored(event)])
    expect(history).toEqual([stored(event)])
    expect(splitSyntheticUserText(history[0].content)).toEqual(splitSyntheticUserText(TRANSCRIPT_TEXT))

    expect(desktopAfterReload(history, event).map((m) => m.id)).toEqual([stored(event).id])
    expect(phoneAfterReseed(history, event)).toEqual([
      { kind: 'synthetic', id: `h-${stored(event).id}-s0`, part: splitSyntheticUserText(TRANSCRIPT_TEXT)!.parts[0], at: event.at },
    ])
  })

  it('shows one row when the transcript has the line too', () => {
    const event = liveEvent()
    const history = mergeConversationMessages([transcriptLine(event.at)], [stored(event)])
    expect(history).toEqual([transcriptLine(event.at)])
    expect(desktopAfterReload(history, event).map((m) => m.id)).toEqual(['jsonl-uuid'])
    expect(phoneAfterReseed(history, event).map((i) => i.id)).toEqual(['h-jsonl-uuid-s0'])
  })

  it('pairs a line only with the same occurrence of its task', () => {
    const event = liveEvent()
    // Same task and fields, consumed well after the notice: still its line.
    const late = { ...transcriptLine(event.at), timestamp: event.at + 60_000 }
    expect(mergeConversationMessages([late], [stored(event)])).toEqual([late])
    // Another task's line with equal fields does not claim it.
    const other = { ...transcriptLine(event.at), content: TRANSCRIPT_TEXT.replace('bd5t7u1q8</task-id>', 'zz</task-id>') }
    expect(mergeConversationMessages([other], [stored(event)]).map((m) => m.id)).toEqual([stored(event).id, 'jsonl-uuid'])
    // A line with no task id pairs on fields inside the skew only.
    const bare = { ...transcriptLine(event.at), content: TRANSCRIPT_TEXT.replace(/<task-id>.*<\/task-id>\n/, '') }
    expect(mergeConversationMessages([bare], [stored(event)])).toEqual([bare])
    expect(mergeConversationMessages([{ ...bare, timestamp: event.at + 6_000 }], [stored(event)])).toHaveLength(2)
  })

  // Recorded from a Monitor task on this machine: one notice per event, then
  // one when its stream ended. The last was queued and never written as a line.
  const monitor = (uuid: string, summary: string, at: number): RuntimeTaskNotificationEvent => ({
    type: 'task.notification', threadId: T, messageId: `task_${uuid}`, taskId: 'bkjj7ulhp', status: 'completed', summary, at,
  })
  const lineFor = (event: RuntimeTaskNotificationEvent, id: string): ChatMessage => ({
    id, role: 'user', content: taskNotificationText(event), timestamp: event.at + 100,
  })

  it('keeps each notice of a task that reports more than once', () => {
    const web = monitor('u1', 'Monitor event: "scout deploy workflows after merge"', 1_000)
    const ended = monitor('u2', 'Monitor "scout deploy workflows after merge" stream ended', 500_000)
    const merged = mergeConversationMessages([lineFor(web, 'line-web')], [stored(web), stored(ended)])
    expect(merged.map((m) => m.id)).toEqual(['line-web', stored(ended).id])

    expect(desktopAfterReload(merged, ended).map((m) => m.id)).toEqual(['line-web', stored(ended).id])
    expect(phoneAfterReseed(merged, ended).map((i) => i.id)).toEqual(['h-line-web-s0', `h-${stored(ended).id}-s0`])

    // The other way round: the earlier notice was dropped, the later one written.
    expect(mergeConversationMessages([lineFor(ended, 'line-ended')], [stored(web), stored(ended)]).map((m) => m.id))
      .toEqual([stored(web).id, 'line-ended'])
  })

  it('gives a line to the equal notice it was written for', () => {
    // Two events with the same summary: the first line was dropped, the second written.
    const first = monitor('u1', 'Monitor event: "deploy"', 1_000)
    const second = monitor('u2', 'Monitor event: "deploy"', 60_000)
    const merged = mergeConversationMessages([lineFor(second, 'line-2')], [stored(first), stored(second)])
    expect(merged.map((m) => m.id)).toEqual([stored(first).id, 'line-2'])
  })
})

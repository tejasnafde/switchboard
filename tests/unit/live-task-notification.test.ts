import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../../src/main/provider/adapters/claude-adapter'
import { mergeConversationMessages } from '../../src/main/agent/dedupe-messages'
import { reduceProviderEvent } from '../../src/renderer/components/chat/provider-event-reducer'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import { flushQueue, resetQueue, threadKey, useChatStore } from '../../apps/mobile/src/stores/chat'
import { splitSyntheticUserText, taskNotificationText } from '../../src/shared/synthetic-message'
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
  const reloaded: ChatMessage = { id: 'jsonl-uuid', role: 'user', content: TRANSCRIPT_TEXT, timestamp: 5_000 }

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
    const history = mergeConversationMessages([reloaded], [])
    useAgentStore.getState().setMessages(T, history)
    expect(messages()).toEqual([reloaded])
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
})

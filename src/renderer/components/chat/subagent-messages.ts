import type { ChatMessage, ToolCall } from '@shared/types'
import { splitSyntheticUserText } from '@shared/synthetic-message'
import {
  groupSubagentEntries,
  isSubagentToolName,
  type SubagentCompletion,
  type SubagentEntryFacts,
  type SubagentGrouping,
  type SubagentStep,
  type TaskNoticePart,
} from '@shared/subagent-steps'

/** The task notices of a user row nobody typed; a row with typed text has none here. */
function noticeParts(message: ChatMessage): TaskNoticePart[] {
  if (message.role !== 'user' || message.displayBody !== undefined) return []
  const split = splitSyntheticUserText(message.content)
  if (!split || split.userText) return []
  return split.parts.filter((part): part is TaskNoticePart => part.kind === 'task-notification')
}

export function chatMessageSubagentFacts(message: ChatMessage): SubagentEntryFacts {
  return {
    toolCalls: message.toolCalls,
    parentToolCallId: message.parentToolCallId,
    noticeToolUseId: noticeParts(message).find((part) => part.toolUseId)?.toolUseId,
  }
}

/** The desktop's messages split into the top level and each agent's steps. */
export function groupChatSubagents(messages: readonly ChatMessage[]): SubagentGrouping<ChatMessage> {
  return groupSubagentEntries(messages, chatMessageSubagentFacts)
}

/** The Agent/Task calls of a row that holds nothing else, which renders as agent rows. */
export function subagentCallsOf(message: ChatMessage): ToolCall[] {
  const calls = message.toolCalls ?? []
  return calls.length > 0 && calls.every((call) => isSubagentToolName(call.name)) ? calls : []
}

function parsedInput(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

export interface ChatSubagentSteps {
  steps: SubagentStep[]
  /** Each tool step's call and row, by step key, to render it with the tool row components. */
  calls: Map<string, { call: ToolCall; messageId: string }>
}

export function chatSubagentSteps(messages: readonly ChatMessage[]): ChatSubagentSteps {
  const steps: SubagentStep[] = []
  const calls = new Map<string, { call: ToolCall; messageId: string }>()
  for (const message of messages) {
    if (message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        steps.push({
          kind: 'tool',
          key: call.id,
          toolName: call.name,
          input: parsedInput(call.input),
          ...(call.output !== undefined ? { output: call.output } : {}),
          ...(call.isError ? { isError: true } : {}),
        })
        calls.set(call.id, { call, messageId: message.id })
      }
      continue
    }
    const notices = noticeParts(message)
    if (notices.length > 0) {
      notices.forEach((part, index) => steps.push({ kind: 'notice', key: `${message.id}:${index}`, part }))
    } else if (message.role === 'assistant' && message.content) {
      steps.push({ kind: 'text', key: message.id, text: message.content })
    }
  }
  return { steps, calls }
}

export function chatSubagentCompletions(messages: readonly ChatMessage[]): SubagentCompletion[] {
  return messages.flatMap((message) => noticeParts(message).map((part) => ({ part, at: message.timestamp })))
}

import type { ChatMessage } from '@shared/types'
import type { ChatLoadTiming } from '@shared/perf-chat'
import { splitSyntheticUserText } from '@shared/synthetic-message'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMainLogger } from '../logger'
import { loadJsonlCached } from './jsonl-cache'

const log = createMainLogger('agent:subagent-transcripts')

/**
 * Claude Code writes each subagent's transcript beside the session's:
 * `<project>/<session>/subagents/agent-<id>.jsonl`, with an
 * `agent-<id>.meta.json` naming the Agent/Task call that started it
 * (`toolUseId`). The session's own transcript holds only that call.
 */
export function subagentDir(sessionJsonlPath: string): string {
  return join(sessionJsonlPath.replace(/\.jsonl$/, ''), 'subagents')
}

export interface SubagentTranscript {
  toolUseId: string
  path: string
}

/** The session's subagent transcripts. A session without any is a normal miss. */
export async function listSubagentTranscripts(sessionJsonlPath: string): Promise<SubagentTranscript[]> {
  const dir = subagentDir(sessionJsonlPath)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') log.warn(`cannot list ${dir}: ${code ?? String(err)}`)
    return []
  }
  const found: SubagentTranscript[] = []
  for (const name of names.filter((n) => n.endsWith('.meta.json')).sort()) {
    const metaPath = join(dir, name)
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { toolUseId?: unknown }
      if (typeof meta.toolUseId !== 'string' || !meta.toolUseId) continue
      found.push({ toolUseId: meta.toolUseId, path: join(dir, name.replace(/\.meta\.json$/, '.jsonl')) })
    } catch (err) {
      log.warn(`skipping unreadable subagent meta ${metaPath}: ${(err as { code?: string }).code ?? String(err)}`)
    }
  }
  return found
}

/**
 * What a reload shows of one subagent: its tool calls, stamped with the
 * Agent/Task call, and its background task notices (placed by their own
 * tool-use id). Its prompt and its prose stay out, as they do live: the
 * prompt is the Agent call's input and the report is its result.
 */
export function subagentStepMessages(messages: readonly ChatMessage[], toolUseId: string): ChatMessage[] {
  const steps: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      steps.push({
        ...message,
        content: '',
        toolCalls: message.toolCalls.map((call) => ({ ...call, parentToolCallId: call.parentToolCallId ?? toolUseId })),
      })
    } else if (message.role === 'user') {
      const parts = splitSyntheticUserText(message.content)?.parts ?? []
      if (parts.length > 0 && parts.every((part) => part.kind === 'task-notification')) steps.push(message)
    }
  }
  return steps
}

/**
 * Every subagent step of one session, from the first copy that has
 * subagent transcripts (profile copies hold the same ones). `sources` gets
 * each parsed array, so a caller memoising on them sees a changed file.
 */
export async function loadSubagentSteps(
  sessionJsonlPaths: readonly string[],
  timing: ChatLoadTiming,
  sources: unknown[],
): Promise<ChatMessage[]> {
  for (const sessionPath of sessionJsonlPaths) {
    const transcripts = await listSubagentTranscripts(sessionPath)
    if (transcripts.length === 0) continue
    const steps: ChatMessage[] = []
    for (const { toolUseId, path } of transcripts) {
      const messages = await loadJsonlCached(path, 'claude-code', timing)
      if (!messages) continue
      sources.push(messages)
      steps.push(...subagentStepMessages(messages, toolUseId))
    }
    return steps
  }
  return []
}

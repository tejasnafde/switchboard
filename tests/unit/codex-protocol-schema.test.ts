/**
 * Codex app-server wire shapes against the schema the installed CLI
 * generates (tests/fixtures/codex-app-server-schema.json, regenerate with
 * `node scripts/codex-app-server-schema.mjs`). What codex-adapter.ts sends is
 * checked by codex-adapter.test.ts's afterEach; this file checks what the
 * adapter and the usage probes READ, and what the usage probes send.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { clientTrafficProblems, codexSchema, schemaHasPath, schemaProblems } from './helpers/codex-schema'
import { codexApprovalResult } from '../../src/main/provider/adapters/codex-adapter'

const { clientRequests, serverRequests, serverNotifications } = codexSchema.methods

// The fields our code reads, by where they arrive. A path that only an older
// or other build sends (a fallback name such as `text` beside `delta`) is
// left out: the schema is the current build's.
const RESULT_READS: Record<string, string[]> = {
  'thread/start': ['thread.id'],
  'thread/resume': ['thread.id'],
  'turn/start': ['turn.id'],
  'turn/steer': ['turnId'],
  'skills/list': [
    'data[].skills[].name',
    'data[].skills[].description',
    'data[].skills[].path',
    'data[].skills[].enabled',
  ],
  'model/list': [
    'data[].id',
    'data[].model',
    'data[].hidden',
    'data[].displayName',
    'data[].supportedReasoningEfforts[].reasoningEffort',
    'data[].defaultReasoningEffort',
  ],
  'account/read': ['account(chatgpt).email', 'account(chatgpt).planType', 'account.type'],
  'account/rateLimits/read': [
    'rateLimits.limitName',
    'rateLimits.limitId',
    'rateLimits.rateLimitReachedType',
    'rateLimits.primary.usedPercent',
    'rateLimits.primary.windowDurationMins',
    'rateLimits.primary.resetsAt',
    'rateLimits.secondary.usedPercent',
    'rateLimits.individualLimit.remainingPercent',
    'rateLimits.individualLimit.resetsAt',
    'rateLimits.individualLimit.used',
    'rateLimits.individualLimit.limit',
    'rateLimits.credits.hasCredits',
    'rateLimits.credits.unlimited',
    'rateLimits.credits.balance',
    'rateLimits.planType',
    'rateLimitsByLimitId',
    'rateLimitResetCredits.availableCount',
    'rateLimitResetCredits.credits[].id',
    'rateLimitResetCredits.credits[].status',
    'rateLimitResetCredits.credits[].expiresAt',
    'rateLimitResetCredits.credits[].title',
  ],
  'account/rateLimitResetCredit/consume': ['outcome'],
}

const SERVER_REQUEST_READS: Record<string, string[]> = {
  'mcpServer/elicitation/request': ['serverName', 'message', 'mode', 'requestedSchema'],
  'item/tool/requestUserInput': [
    'questions[].id',
    'questions[].header',
    'questions[].question',
    'questions[].options[].label',
    'questions[].options[].description',
  ],
  'item/permissions/requestApproval': ['permissions'],
}

const NOTIFICATION_READS: Record<string, string[]> = {
  'thread/started': ['thread.id'],
  'thread/status/changed': ['threadId', 'status.type'],
  'thread/tokenUsage/updated': [
    'tokenUsage.last.totalTokens',
    'tokenUsage.total.totalTokens',
    'tokenUsage.modelContextWindow',
  ],
  'turn/started': ['turn.id'],
  'turn/completed': ['turn.id', 'turn.status', 'turn.error.message', 'turn.error.codexErrorInfo'],
  'turn/plan/updated': ['turnId', 'plan[].step', 'plan[].status'],
  'item/started': ['item.id', 'item.type'],
  'item/completed': [
    'item.id',
    'item.type',
    'item(agentMessage).text',
    'item(reasoning).summary',
    'item(reasoning).content',
    'item(plan).text',
    'item(fileChange).changes[].path',
    'item(fileChange).changes[].diff',
    'item(fileChange).status',
    'item(commandExecution).command',
    'item(commandExecution).cwd',
    'item(commandExecution).aggregatedOutput',
    'item(mcpToolCall).server',
    'item(mcpToolCall).tool',
    'item(mcpToolCall).arguments',
    'item(mcpToolCall).result',
    'item(mcpToolCall).error',
    'item(dynamicToolCall).tool',
    'item(dynamicToolCall).namespace',
    'item(dynamicToolCall).arguments',
    'item(dynamicToolCall).contentItems',
    'item(collabAgentToolCall).tool',
    'item(collabAgentToolCall).prompt',
    'item(collabAgentToolCall).model',
    'item(collabAgentToolCall).agentsStates',
    'item(webSearch).query',
    'item(webSearch).action',
    'item(imageView).path',
    'item(imageGeneration).savedPath',
    'item(imageGeneration).result',
  ],
  'item/agentMessage/delta': ['itemId', 'delta'],
  'item/plan/delta': ['itemId', 'delta'],
  'item/reasoning/summaryTextDelta': ['itemId', 'delta'],
  'item/reasoning/textDelta': ['itemId', 'delta'],
  'item/commandExecution/outputDelta': ['itemId', 'delta'],
  'item/fileChange/patchUpdated': ['itemId', 'changes[].path', 'changes[].diff'],
  error: ['error.message', 'error.codexErrorInfo', 'turnId', 'willRetry'],
}

function missingReads(table: Record<string, string[]>, refOf: (method: string) => string | null | undefined) {
  return Object.entries(table).flatMap(([method, paths]) => {
    const ref = refOf(method)
    if (!ref) return [`${method}: not in the schema fixture`]
    return paths.filter((path) => !schemaHasPath(ref, path)).map((path) => `${method}: ${path}`)
  })
}

describe(`Codex app-server reads (${codexSchema.codexVersion})`, () => {
  it('every field read from a request result is in the schema', () => {
    expect(missingReads(RESULT_READS, (m) => clientRequests[m]?.response)).toEqual([])
  })

  it('every field read from a server request is in the schema', () => {
    expect(missingReads(SERVER_REQUEST_READS, (m) => serverRequests[m]?.params)).toEqual([])
  })

  it('every field read from a notification is in the schema', () => {
    expect(missingReads(NOTIFICATION_READS, (m) => serverNotifications[m]?.params)).toEqual([])
  })

  it('catches a field the schema does not have', () => {
    expect(schemaHasPath(clientRequests['thread/start'].response!, 'thread.identifier')).toBe(false)
  })
})

describe('Codex approval answers', () => {
  const response = (method: string) => serverRequests[method].response!

  it('answers command and file approvals with a decision', () => {
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
      for (const approved of [true, false]) {
        expect(schemaProblems(response(method), codexApprovalResult(method, {}, approved), true)).toEqual([])
      }
    }
  })

  it('answers a permissions request with the profile it grants, for this turn', () => {
    const method = 'item/permissions/requestApproval'
    const permissions = { network: { enabled: true } }
    const granted = codexApprovalResult(method, { permissions }, true)
    const refused = codexApprovalResult(method, { permissions }, false)
    expect(granted).toEqual({ permissions, scope: 'turn' })
    expect(refused).toEqual({ permissions: {}, scope: 'turn' })
    expect(schemaProblems(response(method), granted, true)).toEqual([])
    expect(schemaProblems(response(method), refused, true)).toEqual([])
  })
})

// A fake `codex app-server` for the usage and reset probes.
const probe = vi.hoisted(() => ({ sent: [] as string[], served: [] as string[] }))

vi.mock('cross-spawn', () => ({
  default: vi.fn(() => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new EventEmitter(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      stdin: Object.assign(new EventEmitter(), {
        end: vi.fn(),
        write: vi.fn((chunk: string) => {
          probe.sent.push(chunk)
          const message = JSON.parse(chunk)
          if (message.id === undefined) return true
          const result =
            message.method === 'account/read'
              ? { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' }, requiresOpenaiAuth: true }
              : message.method === 'account/rateLimits/read'
                ? { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 } } }
                : message.method === 'account/rateLimitResetCredit/consume'
                  ? { outcome: 'reset' }
                  : {}
          const line = JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'
          probe.served.push(line)
          queueMicrotask(() => stdout.write(line))
          return true
        }),
      }),
    })
    return child
  }),
}))

describe('Codex usage probes send what the schema takes', () => {
  const lines = (chunks: string[]) =>
    chunks
      .flatMap((c) => c.split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l) as unknown)

  it('the usage read', async () => {
    probe.sent.length = 0
    const { fetchCodexUsage } = await import('../../src/main/provider/usage/codex-usage')
    const usage = await fetchCodexUsage('codex-1', {}, '/fake/codex', null)
    expect(usage.status).toBe('ok')
    expect(lines(probe.sent).map((m) => (m as { method: string }).method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
    ])
    expect(clientTrafficProblems(lines(probe.sent), lines(probe.served))).toEqual([])
  })

  it('the reset consume', async () => {
    probe.sent.length = 0
    const { consumeCodexReset } = await import('../../src/main/provider/usage/codex-reset')
    await expect(consumeCodexReset({}, '/fake/codex', { idempotencyKey: 'k1', creditId: 'c1' })).resolves.toBe('reset')
    expect(clientTrafficProblems(lines(probe.sent), lines(probe.served))).toEqual([])
  })
})

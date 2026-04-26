import { describe, it, expect } from 'vitest'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type {
  ProviderAdapter,
  RuntimeEvent,
  RuntimeContentEvent,
  RuntimeRequestOpenedEvent,
  RuntimeTurnCompletedEvent,
  ProviderKind,
  RuntimeMode,
  ApprovalDecision,
} from '../../src/main/provider/types'

describe('provider types', () => {
  it('ProviderChannels has all required channels', () => {
    expect(ProviderChannels.START_SESSION).toBe('provider:start-session')
    expect(ProviderChannels.SEND_TURN).toBe('provider:send-turn')
    expect(ProviderChannels.INTERRUPT).toBe('provider:interrupt')
    expect(ProviderChannels.RESPOND_TO_REQUEST).toBe('provider:respond-to-request')
    expect(ProviderChannels.STOP_SESSION).toBe('provider:stop-session')
    expect(ProviderChannels.EVENT).toBe('provider:event')
    expect(ProviderChannels.IS_AVAILABLE).toBe('provider:is-available')
  })

  it('RuntimeEvent union covers all event types', () => {
    // Type-level test: if these assignments compile, the union is correct
    const content: RuntimeEvent = {
      type: 'content',
      threadId: 't1',
      messageId: 'm1',
      text: 'hello',
      streamKind: 'assistant',
    }
    expect(content.type).toBe('content')

    const request: RuntimeEvent = {
      type: 'request.opened',
      threadId: 't1',
      requestId: 'r1',
      requestType: 'command',
      toolName: 'Bash',
      detail: 'npm test',
    }
    expect(request.type).toBe('request.opened')

    const turn: RuntimeEvent = {
      type: 'turn.completed',
      threadId: 't1',
      costUsd: 0.05,
      usedTokens: 5000,
      maxTokens: 200000,
      numTurns: 3,
    }
    expect(turn.type).toBe('turn.completed')
  })

  it('ProviderKind is union of supported providers', () => {
    const kinds: ProviderKind[] = ['claude', 'codex']
    expect(kinds).toHaveLength(2)
  })

  it('RuntimeMode covers all modes', () => {
    const modes: RuntimeMode[] = ['plan', 'sandbox', 'full-access']
    expect(modes).toHaveLength(3)
  })

  it('ApprovalDecision is approve or deny', () => {
    const decisions: ApprovalDecision[] = ['approve', 'deny']
    expect(decisions).toHaveLength(2)
  })
})

import { describe, it, expect } from 'vitest'
import {
  shouldEvictMessages,
  needsMessageReload,
  resolveSessionDisplayTitle,
  resolveSessionOpenAgentType,
  resolveSessionSelectTarget,
  shouldRetrySessionLoadAfterCreate,
} from '../../src/renderer/utils/session-eviction'

describe('resolveSessionSelectTarget', () => {
  it('activates the live thread when the sidebar id is a rotated twin', () => {
    expect(resolveSessionSelectTarget('uuid-1', 'agent_1', ['agent_1'])).toBe('agent_1')
  })

  it('keeps the clicked id when the live thread is not in the store', () => {
    expect(resolveSessionSelectTarget('uuid-1', 'agent_1', ['other'])).toBe('uuid-1')
  })

  it('keeps the clicked id when it is already the root', () => {
    expect(resolveSessionSelectTarget('agent_1', 'agent_1', ['agent_1'])).toBe('agent_1')
  })

  it('keeps the clicked id when the backend sent no root', () => {
    expect(resolveSessionSelectTarget('uuid-1', undefined, ['agent_1'])).toBe('uuid-1')
  })
})

describe('resolveSessionDisplayTitle', () => {
  it('uses the persisted sidebar title when a live adopted session has no title', () => {
    expect(resolveSessionDisplayTitle('branding', 'New conversation')).toBe('branding')
    expect(resolveSessionDisplayTitle('branding', null)).toBe('branding')
  })
})

describe('resolveSessionOpenAgentType', () => {
  it('uses the canonical current provider after a mixed-provider history load', () => {
    expect(resolveSessionOpenAgentType('claude-code', 'codex')).toBe('codex')
  })
})

describe('shouldRetrySessionLoadAfterCreate', () => {
  it('retries a disk-scanned session after its missing conversation row is created', () => {
    expect(shouldRetrySessionLoadAfterCreate(false, '/provider/session.jsonl')).toBe(true)
    expect(shouldRetrySessionLoadAfterCreate(true, '/provider/session.jsonl')).toBe(false)
    expect(shouldRetrySessionLoadAfterCreate(false, '')).toBe(false)
  })
})

describe('session eviction', () => {
  describe('shouldEvictMessages', () => {
    it('evicts an idle session that has messages loaded', () => {
      expect(shouldEvictMessages({
        status: 'idle',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1000 }],
      })).toBe(true)
    })

    it('does not evict a session that is actively running', () => {
      expect(shouldEvictMessages({
        status: 'running',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1000 }],
      })).toBe(false)
    })

    it('does not evict an idle session that already has no messages', () => {
      expect(shouldEvictMessages({ status: 'idle', messages: [] })).toBe(false)
    })

    it('does not evict a session in error state with messages', () => {
      expect(shouldEvictMessages({
        status: 'error',
        messages: [{ id: 'm1', role: 'system', content: 'oops', timestamp: 1000 }],
      })).toBe(false)
    })

    it('does not evict a session that is waiting for user input', () => {
      expect(shouldEvictMessages({
        status: 'waiting-for-input',
        messages: [{ id: 'm1', role: 'assistant', content: '?', timestamp: 1000 }],
      })).toBe(false)
    })
  })

  describe('needsMessageReload', () => {
    it('signals reload when a session has no messages in memory', () => {
      expect(needsMessageReload({ messages: [] })).toBe(true)
    })

    it('does not reload a session that still has messages in memory', () => {
      expect(needsMessageReload({
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1000 }],
      })).toBe(false)
    })
  })
})

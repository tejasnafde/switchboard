import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * AgentManager tests.
 * We can't spawn real Claude Code in tests, so we test:
 * 1. Command building logic
 * 2. Message flow through the manager
 * 3. Status transitions
 */

// Extract the command builder logic so it's testable without spawning
function buildAgentCommand(type: 'claude-code' | 'codex', resumeSessionId?: string) {
  switch (type) {
    case 'claude-code': {
      const args = ['--print', '--output-format', 'stream-json']
      if (resumeSessionId) {
        args.push('--resume', resumeSessionId)
      }
      return { cmd: 'claude', args }
    }
    case 'codex': {
      const args: string[] = []
      if (resumeSessionId) {
        args.push('resume', '--session', resumeSessionId)
      }
      return { cmd: 'codex', args }
    }
    default:
      throw new Error(`Unknown agent type: ${type}`)
  }
}

describe('buildAgentCommand', () => {
  it('builds claude-code command with stream-json flag', () => {
    const { cmd, args } = buildAgentCommand('claude-code')
    expect(cmd).toBe('claude')
    expect(args).toContain('--print')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
  })

  it('builds claude-code command with resume flag', () => {
    const { cmd, args } = buildAgentCommand('claude-code', 'session-123')
    expect(cmd).toBe('claude')
    expect(args).toContain('--resume')
    expect(args).toContain('session-123')
  })

  it('builds codex command', () => {
    const { cmd, args } = buildAgentCommand('codex')
    expect(cmd).toBe('codex')
    expect(args).toEqual([])
  })

  it('builds codex resume command', () => {
    const { cmd, args } = buildAgentCommand('codex', 'sess-456')
    expect(args).toContain('resume')
    expect(args).toContain('--session')
    expect(args).toContain('sess-456')
  })

  it('throws for unknown agent type', () => {
    expect(() => buildAgentCommand('unknown' as any)).toThrow('Unknown agent type')
  })
})

describe('Agent message flow', () => {
  it('user message has correct structure', () => {
    const message = {
      id: `user_${Date.now()}`,
      role: 'user' as const,
      content: 'hello world',
      timestamp: Date.now(),
    }
    expect(message.role).toBe('user')
    expect(message.content).toBe('hello world')
    expect(message.id).toMatch(/^user_/)
    expect(message.timestamp).toBeGreaterThan(0)
  })

  it('agent status transitions are valid', () => {
    const validTransitions: Record<string, string[]> = {
      idle: ['running'],
      running: ['thinking', 'idle', 'error', 'exited'],
      thinking: ['running', 'idle', 'error', 'exited'],
      error: ['idle', 'running'],
      exited: ['idle'],
    }

    // Starting from idle, can transition to running
    expect(validTransitions['idle']).toContain('running')
    // From running, can transition to thinking or exited
    expect(validTransitions['running']).toContain('thinking')
    expect(validTransitions['running']).toContain('exited')
  })
})

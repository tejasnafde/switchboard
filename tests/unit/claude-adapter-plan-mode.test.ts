import { describe, it, expect } from 'vitest'
import {
  decidePermission,
  PLAN_READ_ONLY_TOOLS,
} from '../../src/main/provider/adapters/claude-adapter'

/**
 * Policy tests for `decidePermission` — the pure function that decides
 * whether a tool call should be allowed, denied, or prompted for based on
 * the session's runtime mode.
 *
 * Shipped bug (2026-04-20): Plan mode had no branch in canUseTool, so it
 * fell through to the generic approval prompt. Write went through to disk
 * after the user (or accept-all flow) approved — defeating plan mode.
 *
 * These tests lock in the policy so that regression can't happen silently.
 */
describe('decidePermission — plan mode', () => {
  it('allows read-only tools so the agent can discover context', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'NotebookRead', 'WebFetch', 'WebSearch']) {
      expect(decidePermission('plan', tool)).toBe('allow')
    }
  })

  it('denies all mutations (regression guard — Write used to be allowed)', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(decidePermission('plan', tool)).toBe('deny')
    }
  })

  it('denies Bash in plan mode (agent should not shell out while planning)', () => {
    expect(decidePermission('plan', 'Bash')).toBe('deny')
    expect(decidePermission('plan', 'KillBash')).toBe('deny')
  })

  it('denies unknown / MCP tools by default in plan mode (safe default)', () => {
    expect(decidePermission('plan', 'mcp__slack__post_message')).toBe('deny')
    expect(decidePermission('plan', 'SomeCustomTool')).toBe('deny')
  })

  it('never prompts in plan mode — every decision is allow or deny', () => {
    // Guardrail: plan mode must be deterministic. Prompting would mean the
    // user clicks approve and writes go through anyway — the exact bug.
    const tools = ['Read', 'Write', 'Bash', 'mcp__x__y', 'Random']
    for (const t of tools) {
      expect(decidePermission('plan', t)).not.toBe('prompt')
    }
  })
})

describe('decidePermission — full-access mode', () => {
  it('allows every tool without prompting', () => {
    for (const tool of ['Write', 'Bash', 'Edit', 'mcp__anything__do']) {
      expect(decidePermission('full-access', tool)).toBe('allow')
    }
  })
})

describe('decidePermission — accept-edits mode', () => {
  it('auto-allows Edit/Write/MultiEdit/NotebookEdit', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(decidePermission('accept-edits', tool)).toBe('allow')
    }
  })

  it('prompts for Bash (not an edit tool)', () => {
    expect(decidePermission('accept-edits', 'Bash')).toBe('prompt')
  })

  it('prompts for Read / Grep (read tools are not auto-allowed here; the sandbox handles it)', () => {
    // accept-edits specifically auto-allows file writes but still prompts
    // for other tools. This matches the historical behavior.
    expect(decidePermission('accept-edits', 'Read')).toBe('prompt')
    expect(decidePermission('accept-edits', 'Grep')).toBe('prompt')
  })
})

describe('decidePermission — sandbox mode', () => {
  it('prompts for every tool (default safe mode)', () => {
    for (const tool of ['Read', 'Write', 'Bash', 'Edit', 'mcp__foo__bar']) {
      expect(decidePermission('sandbox', tool)).toBe('prompt')
    }
  })
})

describe('PLAN_READ_ONLY_TOOLS allow-list', () => {
  it('does not include any mutation tool (defense in depth)', () => {
    const mutations = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'KillBash']
    for (const m of mutations) {
      expect(PLAN_READ_ONLY_TOOLS.has(m)).toBe(false)
    }
  })

  it('contains the expected read-only set', () => {
    expect(PLAN_READ_ONLY_TOOLS.has('Read')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('Glob')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('Grep')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('NotebookRead')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('WebFetch')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('WebSearch')).toBe(true)
  })
})

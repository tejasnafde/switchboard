import { describe, it, expect } from 'vitest'
import {
  decidePermission,
  PLAN_READ_ONLY_TOOLS,
  CUSTOM_UI_TOOLS,
  denialMessage,
} from '../../src/main/provider/policy'

/**
 * Shared provider policy — applies to both Claude and Codex adapters.
 * Extracted from claude-adapter.ts in B1a so Codex reuses the exact same
 * gate. These tests are provider-agnostic.
 */

describe('decidePermission (shared)', () => {
  describe('plan mode', () => {
    it('allows Claude read-only tools', () => {
      for (const t of ['Read', 'Glob', 'Grep', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite']) {
        expect(decidePermission('plan', t)).toBe('allow')
      }
    })

    it('allows Codex read-only tool names (read_file, search_files, list_files, fetch)', () => {
      for (const t of ['read_file', 'search_files', 'list_files', 'fetch']) {
        expect(decidePermission('plan', t)).toBe('allow')
      }
    })

    it('denies Claude mutations', () => {
      for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        expect(decidePermission('plan', t)).toBe('deny')
      }
    })

    it('denies Codex mutations (write_file, patch, apply_patch)', () => {
      for (const t of ['write_file', 'patch', 'apply_patch']) {
        expect(decidePermission('plan', t)).toBe('deny')
      }
    })

    it('denies Bash / shell tools', () => {
      expect(decidePermission('plan', 'Bash')).toBe('deny')
      expect(decidePermission('plan', 'shell')).toBe('deny')
    })

    it('never prompts — every decision is allow or deny', () => {
      for (const t of ['Read', 'Write', 'Bash', 'unknown_tool', 'mcp__x__y']) {
        expect(decidePermission('plan', t)).not.toBe('prompt')
      }
    })
  })

  describe('accept-edits mode', () => {
    it('allows Claude edit tools', () => {
      for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
        expect(decidePermission('accept-edits', t)).toBe('allow')
      }
    })

    it('allows Codex write tools (write_file, patch, apply_patch)', () => {
      for (const t of ['write_file', 'patch', 'apply_patch']) {
        expect(decidePermission('accept-edits', t)).toBe('allow')
      }
    })

    it('prompts for Bash / shell', () => {
      expect(decidePermission('accept-edits', 'Bash')).toBe('prompt')
      expect(decidePermission('accept-edits', 'shell')).toBe('prompt')
    })
  })

  describe('full-access mode', () => {
    it('allows everything', () => {
      for (const t of ['Write', 'Bash', 'shell', 'apply_patch', 'mcp__anything__do']) {
        expect(decidePermission('full-access', t)).toBe('allow')
      }
    })
  })

  describe('sandbox mode (default)', () => {
    it('prompts for every tool', () => {
      for (const t of ['Read', 'Write', 'Bash', 'shell', 'Edit']) {
        expect(decidePermission('sandbox', t)).toBe('prompt')
      }
    })
  })
})

describe('PLAN_READ_ONLY_TOOLS', () => {
  it('includes both Claude and Codex read-only tool names', () => {
    // Claude side
    expect(PLAN_READ_ONLY_TOOLS.has('Read')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('Glob')).toBe(true)
    // Codex side
    expect(PLAN_READ_ONLY_TOOLS.has('read_file')).toBe(true)
    expect(PLAN_READ_ONLY_TOOLS.has('search_files')).toBe(true)
  })

  it('does not include any mutation tool (defense in depth)', () => {
    for (const t of ['Write', 'Edit', 'Bash', 'shell', 'apply_patch']) {
      expect(PLAN_READ_ONLY_TOOLS.has(t)).toBe(false)
    }
  })
})

describe('CUSTOM_UI_TOOLS (shared)', () => {
  it('includes Claude special tools', () => {
    expect(CUSTOM_UI_TOOLS.has('AskUserQuestion')).toBe(true)
    expect(CUSTOM_UI_TOOLS.has('ExitPlanMode')).toBe(true)
  })

  it('includes Codex equivalents for dual-provider consistency', () => {
    expect(CUSTOM_UI_TOOLS.has('ask_user_question')).toBe(true)
    expect(CUSTOM_UI_TOOLS.has('exit_plan_mode')).toBe(true)
  })

  it('does not sweep in unrelated tools', () => {
    for (const t of ['Write', 'Bash', 'Read', 'shell']) {
      expect(CUSTOM_UI_TOOLS.has(t)).toBe(false)
    }
  })
})

describe('denialMessage', () => {
  it('uses plan-mode copy when mode is plan', () => {
    const msg = denialMessage('plan', 'Write')
    expect(msg).toContain('Plan mode')
    expect(msg).toContain('ExitPlanMode')
  })

  it('uses generic copy for other denies (rare)', () => {
    const msg = denialMessage('sandbox', 'Bash')
    expect(msg).toBe('Denied by permission policy')
  })
})

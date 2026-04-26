import { describe, it, expect } from 'vitest'
import { CUSTOM_UI_TOOLS } from '../../src/main/provider/adapters/claude-adapter'

/**
 * Regression tests for the "don't emit tool.started for custom-UI tools" rule.
 *
 * Shipped bug (2026-04-20): the adapter's tool_use block loop emitted
 * `tool.started` for every tool, including `AskUserQuestion` and
 * `ExitPlanMode`. These are rendered via QuestionCard / PlanCard driven by
 * `question.asked` / `plan.proposed` events. Emitting tool.started in
 * addition caused the raw JSON tool-call block to appear alongside (or
 * before) the custom card — duplicate + ugly.
 *
 * The fix: loop body now does `if (CUSTOM_UI_TOOLS.has(block.name)) continue`.
 * These tests lock in the membership of that set.
 */
describe('CUSTOM_UI_TOOLS — tools suppressed from tool.started emission', () => {
  it('suppresses AskUserQuestion (rendered by QuestionCard)', () => {
    expect(CUSTOM_UI_TOOLS.has('AskUserQuestion')).toBe(true)
  })

  it('suppresses ExitPlanMode (rendered by PlanCard)', () => {
    expect(CUSTOM_UI_TOOLS.has('ExitPlanMode')).toBe(true)
  })

  it('does NOT suppress normal tools (those still show as ToolCallBlock)', () => {
    for (const tool of ['Read', 'Write', 'Bash', 'Edit', 'Grep', 'Glob']) {
      expect(CUSTOM_UI_TOOLS.has(tool)).toBe(false)
    }
  })

  it('does not suppress MCP tools (they have no custom UI)', () => {
    expect(CUSTOM_UI_TOOLS.has('mcp__slack__post_message')).toBe(false)
  })

  it('keeps the set tight — only Claude+Codex custom-UI tool names', () => {
    // Adding a tool here means you also need a custom card component to
    // render it. If this test fails, make sure the corresponding MessageBubble
    // branch exists before adding to the set.
    // Set = Claude (AskUserQuestion, ExitPlanMode) + Codex equivalents
    // (ask_user_question, exit_plan_mode) = 4 entries.
    expect(CUSTOM_UI_TOOLS.size).toBe(4)
  })

  it('also suppresses Codex equivalents so dual-provider UIs stay consistent', () => {
    expect(CUSTOM_UI_TOOLS.has('ask_user_question')).toBe(true)
    expect(CUSTOM_UI_TOOLS.has('exit_plan_mode')).toBe(true)
  })
})

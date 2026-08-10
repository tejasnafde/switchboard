/**
 * Codex's `update_plan` is a TODO list the model keeps for itself, and it
 * arrives as `turn/plan/updated` notifications throughout a turn. It was
 * mapped to `plan.proposed`, so the UI drew it as an approval-gated plan card
 * with Implement and Iterate buttons - buttons for a decision nobody asked
 * for, on a list that updates repeatedly.
 *
 * A real Codex plan proposal is the `exit_plan_mode` TOOL (see CUSTOM_UI_TOOLS
 * in provider/policy.ts), intercepted separately, so nothing here is one.
 */
import { describe, it, expect } from 'vitest'
import { parseCodexTodoItems } from '../../src/main/provider/adapters/codex-todo'

describe('parseCodexTodoItems', () => {
  it('reads step text and status', () => {
    expect(parseCodexTodoItems({
      plan: [
        { step: 'Review the UI structure', status: 'completed' },
        { step: 'Clarify the target user', status: 'in_progress' },
        { step: 'Propose approaches', status: 'pending' },
      ],
    })).toEqual([
      { text: 'Review the UI structure', status: 'completed' },
      { text: 'Clarify the target user', status: 'in_progress' },
      { text: 'Propose approaches', status: 'pending' },
    ])
  })

  it('defaults an unknown or missing status to pending', () => {
    expect(parseCodexTodoItems({ plan: [{ step: 'a' }, { step: 'b', status: 'wat' }] })).toEqual([
      { text: 'a', status: 'pending' },
      { text: 'b', status: 'pending' },
    ])
  })

  it('drops entries with no step text', () => {
    expect(parseCodexTodoItems({ plan: [{ step: '' }, { status: 'completed' }, { step: 'keep' }] }))
      .toEqual([{ text: 'keep', status: 'pending' }])
  })

  it('returns an empty list for a malformed payload', () => {
    expect(parseCodexTodoItems({})).toEqual([])
    expect(parseCodexTodoItems({ plan: 'nope' })).toEqual([])
    expect(parseCodexTodoItems(undefined)).toEqual([])
  })
})

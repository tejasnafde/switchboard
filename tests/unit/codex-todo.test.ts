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
import { parseCodexTodoItems, parseCodexTodoMarkdown } from '../../src/main/provider/adapters/codex-todo'

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

describe('parseCodexTodoMarkdown', () => {
  // The `item/completed` notification carries the checklist as markdown text,
  // not a plan array. Feeding it to the array parser returned nothing, which
  // silently dropped the list instead of rendering it.
  it('reads checkbox lines', () => {
    expect(parseCodexTodoMarkdown('- [x] Review the UI\n- [ ] Clarify the user')).toEqual([
      { text: 'Review the UI', status: 'completed' },
      { text: 'Clarify the user', status: 'pending' },
    ])
  })

  it('accepts asterisk bullets and stray indentation', () => {
    expect(parseCodexTodoMarkdown('  * [X] done\n* [ ] todo')).toEqual([
      { text: 'done', status: 'completed' },
      { text: 'todo', status: 'pending' },
    ])
  })

  it('falls back to plain bullet lines with no checkbox', () => {
    expect(parseCodexTodoMarkdown('- first\n- second')).toEqual([
      { text: 'first', status: 'pending' },
      { text: 'second', status: 'pending' },
    ])
  })

  it('ignores blank and non-list lines', () => {
    expect(parseCodexTodoMarkdown('Plan:\n\n- [ ] only this\n')).toEqual([
      { text: 'only this', status: 'pending' },
    ])
  })

  it('returns nothing for empty input', () => {
    expect(parseCodexTodoMarkdown('')).toEqual([])
    expect(parseCodexTodoMarkdown('   ')).toEqual([])
  })
})

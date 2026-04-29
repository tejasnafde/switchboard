/**
 * Regression: AskUserQuestion answers were being dropped on the way to the SDK.
 *
 * Root cause: claude-adapter shaped `updatedInput.answers` as
 *   { [q.header]: string | string[] }
 * but the SDK's AskUserQuestionOutput schema (sdk-tools.d.ts) expects
 *   { [q.question]: string }  // multi-select = comma-separated string
 *
 * The SDK silently dropped the field because keys didn't match question text,
 * and even when they did, multi-select arrays didn't unify to a string. Net
 * effect: the agent received empty answers despite the user submitting picks.
 *
 * shapeQuestionAnswers() is the pure function we extract out so we can
 * unit-test it without spinning up the SDK.
 */
import { describe, it, expect } from 'vitest'
import { shapeQuestionAnswers } from '../../src/main/provider/adapters/question-answers'
import type { Question } from '../../src/shared/provider-events'

const q = (over: Partial<Question> & { question: string; multiSelect: boolean }): Question => ({
  id: over.id ?? over.header ?? over.question,
  header: over.header ?? 'H',
  question: over.question,
  multiSelect: over.multiSelect,
  options: over.options ?? [
    { label: 'A', description: 'a' },
    { label: 'B', description: 'b' },
  ],
})

describe('shapeQuestionAnswers', () => {
  it('keys answers by question text (not header) — matches SDK schema', () => {
    const questions = [q({ header: 'Scope', question: 'Which features?', multiSelect: false })]
    const out = shapeQuestionAnswers(questions, [['A']])
    // SDK expects question-text keys; previously buggy code used q.header.
    expect(out.answers).toHaveProperty('Which features?', 'A')
    expect(out.answers).not.toHaveProperty('Scope')
  })

  it('joins multi-select picks with comma-space (SDK contract)', () => {
    const questions = [q({ question: 'Pick scope?', multiSelect: true })]
    const out = shapeQuestionAnswers(questions, [['A', 'B', 'C']])
    expect(out.answers['Pick scope?']).toBe('A, B, C')
  })

  it('returns empty string for unanswered single-select', () => {
    const questions = [q({ question: 'Pick one?', multiSelect: false })]
    const out = shapeQuestionAnswers(questions, [[]])
    expect(out.answers['Pick one?']).toBe('')
  })

  it('returns empty string (not empty array) for unanswered multi-select', () => {
    const questions = [q({ question: 'Pick many?', multiSelect: true })]
    const out = shapeQuestionAnswers(questions, [[]])
    // Type-level: SDK signature is { [k: string]: string }, so empty multi
    // must collapse to empty string, not empty array.
    expect(out.answers['Pick many?']).toBe('')
    expect(typeof out.answers['Pick many?']).toBe('string')
  })

  it('handles mix of multi-select + single-select + free-text in one payload', () => {
    const questions = [
      q({ header: 'Scope', question: 'Which features should ship?', multiSelect: true }),
      q({ header: 'Viewer', question: 'Which renderer?', multiSelect: false }),
      q({ header: 'Launcher', question: 'Add a launcher?', multiSelect: false }),
    ]
    // userAnswers[i] is parallel to questions[i]; QuestionCard already
    // substitutes free-text into picks[0] for single-select, so it arrives
    // here as a normal string in the array.
    const userAnswers = [
      ['Per-turn duration', 'Inline file pills', 'File tree'],
      ['react-shiki - i dont want read-only necessarily'], // free-text
      ['how difficult would ssh agents be?'], // free-text
    ]
    const out = shapeQuestionAnswers(questions, userAnswers)
    expect(out.answers['Which features should ship?']).toBe(
      'Per-turn duration, Inline file pills, File tree',
    )
    expect(out.answers['Which renderer?']).toBe(
      'react-shiki - i dont want read-only necessarily',
    )
    expect(out.answers['Add a launcher?']).toBe('how difficult would ssh agents be?')
  })

  it('payload survives JSON round-trip (no Set/Map instances cross IPC)', () => {
    const questions = [q({ question: 'Pick?', multiSelect: true })]
    const out = shapeQuestionAnswers(questions, [['A', 'B']])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('does not include extra keys beyond what SDK expects', () => {
    const questions = [q({ question: 'X?', multiSelect: false })]
    const out = shapeQuestionAnswers(questions, [['A']])
    // Only `answers` (and optionally `annotations`) per SDK schema.
    const keys = Object.keys(out)
    expect(keys).toContain('answers')
    expect(keys.every((k) => k === 'answers' || k === 'annotations')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { questionAnswersComplete, resolveQuestionAnswers } from '@shared/question-answers'

describe('resolveQuestionAnswers', () => {
  it('keeps picks in pick order and lets typed text replace them', () => {
    expect(resolveQuestionAnswers([['No'], ['iOS', 'Android']], ['', ''])).toEqual([['No'], ['iOS', 'Android']])
    expect(resolveQuestionAnswers([['No'], ['iOS']], ['  do neither  ', ''])).toEqual([['do neither'], ['iOS']])
  })

  it('pads to the question count', () => {
    expect(resolveQuestionAnswers([], ['typed'], 2)).toEqual([['typed'], []])
  })
})

describe('questionAnswersComplete', () => {
  it('needs a pick or non-blank text for every question', () => {
    expect(questionAnswersComplete([['a'], []], ['', ''], 2)).toBe(false)
    expect(questionAnswersComplete([['a'], []], ['', ' '], 2)).toBe(false)
    expect(questionAnswersComplete([['a'], []], ['', 'mine'], 2)).toBe(true)
    expect(questionAnswersComplete([], [], 0)).toBe(false)
  })
})

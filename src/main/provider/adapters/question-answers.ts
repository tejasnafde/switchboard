/**
 * Pure helper: shape user-collected answers into the format the Claude SDK's
 * AskUserQuestion tool expects on `updatedInput`.
 *
 * Wire contract (verified against @anthropic-ai/claude-agent-sdk's
 * `AskUserQuestionOutput` in sdk-tools.d.ts ~L2696):
 *   {
 *     answers: { [questionText]: string }   // multi-select = comma-space joined
 *     annotations?: { [questionText]: { notes?: string; preview?: string } }
 *   }
 *
 * Why a separate module: lets us unit-test the mapping without booting the
 * SDK and catches regressions like the 2026-04-29 bug where we keyed by
 * `q.header` (e.g. "Scope") instead of `q.question` (the actual question
 * text the SDK matches against). The SDK silently dropped the unmatched
 * field, so the agent received `{}` despite a valid user submission.
 */

import type { Question } from '@shared/provider-events'

export interface ShapedAnswerPayload {
  answers: Record<string, string>
  annotations?: Record<string, { notes?: string; preview?: string }>
}

/**
 * @param questions  Parallel to `userAnswers` — i-th question gets i-th answer.
 * @param userAnswers `string[][]` from QuestionCard. For each question, an
 *   array of selected option labels. For "Other" free-text, QuestionCard
 *   collapses the typed string into picks[0] of length 1.
 */
export function shapeQuestionAnswers(
  questions: Question[],
  userAnswers: string[][],
): ShapedAnswerPayload {
  const answers: Record<string, string> = {}

  questions.forEach((q, i) => {
    const picked = userAnswers[i] ?? []
    if (q.multiSelect) {
      // SDK expects a single string: "answer1, answer2, answer3"
      answers[q.question] = picked.join(', ')
    } else {
      answers[q.question] = picked[0] ?? ''
    }
  })

  return { answers }
}

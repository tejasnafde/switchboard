/**
 * What an AskUserQuestion card sends (`provider:answer-question`), shared by
 * the desktop QuestionCard and the React Native phone; Android ports it in
 * `QuestionSelectionReducer`. One row per question: the typed "None of the
 * above" text when there is any (it replaces the picks), else the picked
 * labels in the order they were picked.
 */
export function resolveQuestionAnswers(picks: string[][], otherTexts: string[], count = picks.length): string[][] {
  return Array.from({ length: count }, (_, i) => {
    const text = (otherTexts[i] ?? '').trim()
    return text ? [text] : (picks[i] ?? [])
  })
}

/** Every question has a pick or typed text. */
export function questionAnswersComplete(picks: string[][], otherTexts: string[], count: number): boolean {
  return count > 0 && resolveQuestionAnswers(picks, otherTexts, count).every((row) => row.length > 0)
}

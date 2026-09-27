/**
 * A `review` pill takes the same round trip as the other kinds: the draft
 * expands it into provider text, the submission carries its label and kind,
 * the backend keeps them on reload, and each surface draws it.
 */
import { describe, expect, it } from 'vitest'
import { isValidElement, type ReactElement } from 'react'
import { serializeBodyWithPills } from '../../src/renderer/services/chat-input-body'
import { validateUserTurnSubmission } from '../../src/shared/provider-events'
import { parsePersistedPillsMeta } from '../../src/main/provider/pill-metadata'
import { renderPillBody } from '../../src/renderer/components/chat/render-pill-body'
import { PillChipVisual } from '../../src/renderer/components/chat/lexical/PillChipVisual'
import { pillBodyText } from '../../src/shared/pill-body-text'
import { expandReviewContext, reviewContextLabel, type ReviewContext } from '../../src/shared/review-context'

const ctx: ReviewContext = {
  pr: { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 612 },
  title: 'Sync backoff',
  url: 'https://github.com/tejasnafde/switchboard/pull/612',
  items: [{ kind: 'check', name: 'integration', description: null, url: null }],
}

describe('review pill round trip', () => {
  const pill = { id: 'review-1', kind: 'review' as const, label: reviewContextLabel(ctx), content: expandReviewContext(ctx) }
  const displayBody = 'Fix this [[pill:review-1]] please'
  const pillsMeta = { [pill.id]: { label: pill.label, kind: pill.kind } }

  it('expands into the provider text and stays a token in the display body', () => {
    const providerText = serializeBodyWithPills(displayBody, { [pill.id]: pill })
    expect(providerText).toBe(`Fix this ${pill.content} please`)
    expect(providerText).toContain('Failed check: integration')
    expect(validateUserTurnSubmission({ version: 1, threadId: 't', origin: 'o', providerText, displayBody, pillsMeta }).pillsMeta).toEqual(pillsMeta)
  })

  it('survives the stored reload with its kind', () => {
    expect(parsePersistedPillsMeta(JSON.stringify(pillsMeta))).toEqual(pillsMeta)
  })

  it('renders as one chip on the desktop and as its label on the phone', () => {
    const chips = renderPillBody(displayBody, pillsMeta).filter((n) => isValidElement(n) && (n as ReactElement).type === PillChipVisual)
    expect(chips).toHaveLength(1)
    expect(((chips[0] as ReactElement).props as { kind: string }).kind).toBe('review')
    expect(pillBodyText(displayBody, pillsMeta)).toBe('Fix this [1 failed check · #612 · integration] please')
    expect(pillBodyText('a [[pill:gone]] b', pillsMeta)).toBe('a  b')
    expect(pillBodyText('[[pill:toString]]', {})).toBe('')
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const inputSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatInput.tsx', import.meta.url),
  'utf8',
)
const panelSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatPanel.tsx', import.meta.url),
  'utf8',
)

describe('desktop image send acceptance contract', () => {
  it('awaits send acceptance before clearing the composer', () => {
    const awaitSend = inputSource.indexOf('await onSend(')
    const clearDraft = inputSource.indexOf('clearDraft(submittedSessionId)', awaitSend)
    expect(awaitSend).toBeGreaterThan(-1)
    expect(clearDraft).toBeGreaterThan(awaitSend)
    expect(inputSource).toContain('sessionIdRef.current !== submittedSessionId')
  })

  it('validates prepared images before optimistic append and provider startup', () => {
    const validation = panelSource.indexOf('messageImages = validateUserMessageImages(prepared)')
    const queueAdmission = panelSource.indexOf('messageQueueRef.current.push(', validation)
    const optimisticAppend = panelSource.indexOf('appendMessage(sessionId, userMsg)', validation)
    const providerStart = panelSource.indexOf('await providerApi.startSession(', validation)
    expect(validation).toBeGreaterThan(-1)
    expect(queueAdmission).toBeGreaterThan(validation)
    expect(optimisticAppend).toBeGreaterThan(validation)
    expect(providerStart).toBeGreaterThan(validation)
  })

  it('renders attachment rejection in the composer instead of a persisted system bubble', () => {
    expect(inputSource).toContain('data-composer-send-error')
    expect(panelSource).toContain("return { accepted: false, error: imageError }")
  })
})

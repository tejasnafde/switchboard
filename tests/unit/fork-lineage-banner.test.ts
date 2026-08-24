import { describe, expect, it } from 'vitest'
import { forkResumeLabel } from '../../src/renderer/components/chat/ForkLineageBanner'
import type { ForkLineageMetadata } from '../../src/shared/conversation-fork'

const metadata = {
  parentConversationId: 'parent',
  parentTitle: 'Parent chat',
  anchor: {
    messageId: 'message', role: 'user', timestamp: 1, contentDigest: 'a'.repeat(64),
    canonicalIndex: 0, canonicalMessageCount: 1, resolution: 'exact-id', preview: 'Fix this bug',
  },
  resumeMode: 'transcript-handoff',
  warnings: [],
} satisfies ForkLineageMetadata

describe('fork lineage banner', () => {
  it('states the durable resume mode plainly', () => {
    expect(forkResumeLabel(metadata)).toBe('Transcript handoff')
    expect(forkResumeLabel({ ...metadata, resumeMode: 'native' })).toBe('Native resume')
  })
})

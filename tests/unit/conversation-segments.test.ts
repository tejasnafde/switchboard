import { describe, expect, it } from 'vitest'
import type { ConversationSegmentRow } from '../../src/main/db/database'
import { selectResumeSegment } from '../../src/main/db/database'

const segment = (
  ordinal: number,
  provider: ConversationSegmentRow['provider'],
  instance: string | null,
): ConversationSegmentRow => ({
  id: `segment-${ordinal}`,
  conversation_id: 'root',
  provider,
  provider_session_id: `native-${ordinal}`,
  provider_instance_id: instance,
  ordinal,
  created_at: ordinal,
  updated_at: ordinal,
})

describe('selectResumeSegment', () => {
  it('prefers the newest segment on the requested provider instance', () => {
    const segments = [segment(0, 'codex', 'work'), segment(1, 'codex', 'personal')]
    expect(selectResumeSegment(segments, 'codex', 'work')?.provider_session_id).toBe('native-0')
  })

  it('falls back only within the requested provider when the instance association moved', () => {
    const segments = [segment(0, 'claude-code', 'work'), segment(1, 'codex', 'personal')]
    expect(selectResumeSegment(segments, 'codex', 'work')?.provider_session_id).toBe('native-1')
  })
})

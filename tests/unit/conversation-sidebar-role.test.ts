import { describe, expect, it } from 'vitest'
import {
  classifyLegacyConversationSidebarRole,
  logicalImportConversationId,
} from '../../src/main/db/conversationSidebarRole'

describe('classifyLegacyConversationSidebarRole', () => {
  it('keeps app-owned and referenced conversations managed', () => {
    expect(classifyLegacyConversationSidebarRole({ id: 'agent_1' })).toBe('managed')
    expect(classifyLegacyConversationSidebarRole({ id: 'uuid', messageCount: 1 })).toBe('managed')
    expect(classifyLegacyConversationSidebarRole({ id: 'uuid', segmentCount: 1 })).toBe('managed')
    expect(classifyLegacyConversationSidebarRole({ id: 'uuid', forkedAtMessageId: 'm1' })).toBe('managed')
    expect(classifyLegacyConversationSidebarRole({ id: 'uuid', referenceCount: 1 })).toBe('managed')
    expect(classifyLegacyConversationSidebarRole({ id: 'uuid', threadChildCount: 1 })).toBe('managed')
  })

  it('moves evidence-free native rows to recovery instead of deleting them', () => {
    expect(classifyLegacyConversationSidebarRole({ id: '019ff606-raw-worker' })).toBe('recovery')
    expect(classifyLegacyConversationSidebarRole({
      id: '019ff606-clicked-worker',
      layoutCount: 1,
    })).toBe('recovery')
  })
})

describe('logicalImportConversationId', () => {
  it('reuses the canonical root for a foreground fragment', () => {
    expect(logicalImportConversationId('native-v0', 'agent-root', false, 'new-root')).toBe('agent-root')
  })

  it('promotes delegated runs into a new root', () => {
    expect(logicalImportConversationId('worker', 'agent-root', true, 'new-root')).toBe('new-root')
  })
})

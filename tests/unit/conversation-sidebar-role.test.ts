import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  classifyLegacyConversationSidebarRole,
  logicalImportConversationId,
  recoveryCandidateTitle,
} from '../../src/main/db/conversationSidebarRole'
const databaseSource = readFileSync(new URL('../../src/main/db/database.ts', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../src/main/ipc/app.ts', import.meta.url), 'utf8')

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

describe('recoveryCandidateTitle', () => {
  it('prefers the native conversation title so an archived v0 remains discoverable', () => {
    expect(recoveryCandidateTitle('Session 6', 'v0', 'git clone the repository')).toBe('v0')
  })

  it('falls back through the canonical root and scanner title', () => {
    expect(recoveryCandidateTitle('Session 6', null, 'Long chat')).toBe('Long chat')
    expect(recoveryCandidateTitle('Session 6', null, null)).toBe('Session 6')
  })
})

describe('existing conversation recovery contract', () => {
  it('revives an existing root without overwriting its active provider selection', () => {
    expect(databaseSource).toMatch(/export function reviveConversationForRecovery[\s\S]*?\): RecoveryReviveResult/)
    expect(databaseSource).toMatch(/export function reviveConversationForRecovery[\s\S]*?UPDATE conversations[\s\S]*?sidebar_role = 'managed'[\s\S]*?archived = 0[\s\S]*?title = \?[\s\S]*?WHERE id = \?[\s\S]*?changes > 0/)
    const body = databaseSource.match(/export function reviveConversationForRecovery[\s\S]*?\n\}/)?.[0] ?? ''
    expect(body).not.toMatch(/agent_type\s*=/)
    expect(body).not.toMatch(/session_id\s*=/)
    expect(body).not.toMatch(/provider_instance_id\s*=/)
    expect(body).not.toMatch(/model\s*=/)
  })

  it('revives the known owner instead of returning a successful archived no-op', () => {
    expect(appSource).toMatch(/if \(existingId\) \{[\s\S]*?reviveConversationForRecovery\(existingId,[\s\S]*?const messages = await loadJsonlCached/)
    const earlyExistingBranch = appSource.slice(
      appSource.indexOf('if (existingId) {'),
      appSource.indexOf('const messages = await loadJsonlCached'),
    )
    expect(earlyExistingBranch).not.toContain('return { ok: true')
  })

  it('distinguishes missing lineage from a cross-project collision', () => {
    expect(databaseSource).toMatch(/export type RecoveryReviveResult = 'revived' \| 'missing' \| 'project-mismatch'/)
    expect(appSource).toContain("reviveResult === 'project-mismatch'")
    expect(appSource).toContain('The stored conversation no longer exists')
  })

  it('does not attach transcript data when a canonical id belongs to another project', () => {
    const reviveBranch = appSource.slice(
      appSource.indexOf('if (getConversationById(conversationId))'),
      appSource.indexOf('recordConversationSegment({'),
    )
    expect(reviveBranch).toContain('reviveConversationForRecovery(conversationId')
    expect(reviveBranch).toContain("reviveResult !== 'revived'")
    expect(reviveBranch).toContain('return reviveResult')
  })
})

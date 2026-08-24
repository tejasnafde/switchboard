import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  parseWorktreeCreationRequest,
  type WorktreeCreationRequest,
  type WorktreeCreationSnapshot,
} from '@shared/worktree-creation'
import type { MobileNewSessionIntent } from './newSessionCreation'

const KEY_PREFIX = '@switchboard/new-session-creation/v1'

export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface PersistedMobileNewSessionCreation {
  version: 1
  submissionPhase: 'prepared' | 'submitted'
  intent: MobileNewSessionIntent
  request: WorktreeCreationRequest
  snapshot?: WorktreeCreationSnapshot
}

export interface MobileNewSessionCreationStorage {
  key(connectionId: string, projectPath: string): string
  save(record: PersistedMobileNewSessionCreation): Promise<void>
  load(connectionId: string, projectPath: string): Promise<PersistedMobileNewSessionCreation | null>
  remove(connectionId: string, projectPath: string): Promise<void>
}

function key(connectionId: string, projectPath: string): string {
  return `${KEY_PREFIX}/${encodeURIComponent(connectionId)}/${encodeURIComponent(projectPath)}`
}

function parsePersistedRecord(value: unknown): PersistedMobileNewSessionCreation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<PersistedMobileNewSessionCreation>
  if (record.version !== 1 || !record.intent || typeof record.intent !== 'object') return null
  const parsed = parseWorktreeCreationRequest(record.request)
  if (!parsed.ok) return null
  const intent = record.intent as Partial<MobileNewSessionIntent>
  const validIdentity = typeof intent.connectionId === 'string' &&
    typeof intent.machineId === 'string' &&
    typeof intent.projectPath === 'string' &&
    intent.connectionId.length > 0 &&
    intent.projectPath.length > 0 &&
    parsed.value.creationId === record.request?.creationId &&
    parsed.value.repository.machineId === intent.machineId &&
    parsed.value.repository.projectPath === intent.projectPath
  if (!validIdentity) return null
  if (record.submissionPhase !== undefined &&
    record.submissionPhase !== 'prepared' &&
    record.submissionPhase !== 'submitted') return null
  return {
    ...(record as Omit<PersistedMobileNewSessionCreation, 'submissionPhase'>),
    submissionPhase: record.submissionPhase ?? 'submitted',
  }
}

export function createMobileNewSessionCreationStorage(
  storage: AsyncKeyValueStorage = AsyncStorage,
): MobileNewSessionCreationStorage {
  return {
    key,
    async save(record) {
      await storage.setItem(key(record.intent.connectionId, record.intent.projectPath), JSON.stringify(record))
    },
    async load(connectionId, projectPath) {
      const storageKey = key(connectionId, projectPath)
      const raw = await storage.getItem(storageKey)
      if (raw === null) return null
      try {
        const parsed: unknown = JSON.parse(raw)
        const record = parsePersistedRecord(parsed)
        if (record) return record
      } catch {
        // Removed below. A corrupted identity must never be retried under a guess.
      }
      await storage.removeItem(storageKey)
      return null
    },
    remove(connectionId, projectPath) {
      return storage.removeItem(key(connectionId, projectPath))
    },
  }
}

export const mobileNewSessionCreationStorage = createMobileNewSessionCreationStorage()

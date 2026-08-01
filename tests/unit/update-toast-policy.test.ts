import { describe, it, expect } from 'vitest'
import { shouldShowUpdateToast } from '../../src/renderer/components/updateToastPolicy'
import type { UpdateStatus } from '@shared/update-status'

describe('shouldShowUpdateToast', () => {
  it('shows when an update is downloaded and nothing was dismissed', () => {
    expect(shouldShowUpdateToast({ kind: 'downloaded', version: '1.2.0' }, null)).toBe(true)
  })

  it('stays hidden for every non-downloaded status', () => {
    const statuses: UpdateStatus[] = [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'up-to-date', version: '1.1.0' },
      { kind: 'available', version: '1.2.0' },
      { kind: 'downloading', percent: 50 },
      { kind: 'error', message: 'boom' },
      { kind: 'unsupported', reason: 'dev build' },
    ]
    for (const status of statuses) {
      expect(shouldShowUpdateToast(status, null)).toBe(false)
    }
  })

  it('stays hidden after the same version was dismissed', () => {
    expect(shouldShowUpdateToast({ kind: 'downloaded', version: '1.2.0' }, '1.2.0')).toBe(false)
  })

  it('re-shows when a newer version downloads after a dismissal', () => {
    expect(shouldShowUpdateToast({ kind: 'downloaded', version: '1.3.0' }, '1.2.0')).toBe(true)
  })
})

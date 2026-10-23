import { describe, it, expect } from 'vitest'
import { hiddenUpdateToast, updateToastAfter } from '../../src/renderer/components/update-toast-policy'
import { releaseNotesUrl, statusWhileReady, updatedNoticeVersion, type UpdateStatus } from '@shared/update-status'

const ready = (version: string): UpdateStatus => ({ kind: 'downloaded', version })

describe('updateToastAfter', () => {
  it('shows once an update is downloaded', () => {
    expect(updateToastAfter(hiddenUpdateToast, ready('1.2.0'))).toEqual({ version: '1.2.0', visible: true })
  })

  it('stays hidden until anything has downloaded', () => {
    const statuses: UpdateStatus[] = [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'up-to-date', version: '1.1.0' },
      { kind: 'available', version: '1.2.0' },
      { kind: 'downloading', percent: 50 },
      { kind: 'error', message: 'boom' },
      { kind: 'unsupported', reason: 'dev build' },
    ]
    for (const status of statuses) expect(updateToastAfter(hiddenUpdateToast, status).visible).toBe(false)
  })

  // A later check, or a failed one, does not make the downloaded update go away.
  it('keeps a downloaded update on screen through later statuses', () => {
    let state = updateToastAfter(hiddenUpdateToast, ready('1.2.0'))
    for (const status of [{ kind: 'checking' }, { kind: 'error', message: 'offline' }] as UpdateStatus[]) {
      state = updateToastAfter(state, status)
    }
    expect(state).toEqual({ version: '1.2.0', visible: true })
  })

  // 2026-10-22: "Later" hid the version for the whole session, so the prompt
  // never came back. The next check reports the download again and shows it.
  it('shows again on the next downloaded report after "Later"', () => {
    const dismissed = { ...updateToastAfter(hiddenUpdateToast, ready('1.2.0')), visible: false }
    expect(updateToastAfter(dismissed, { kind: 'checking' }).visible).toBe(false)
    expect(updateToastAfter(dismissed, ready('1.2.0')).visible).toBe(true)
    expect(updateToastAfter(dismissed, ready('1.3.0'))).toEqual({ version: '1.3.0', visible: true })
  })
})

describe('updatedNoticeVersion', () => {
  it('announces a changed version only', () => {
    expect(updatedNoticeVersion('0.9.100', '0.9.106')).toBe('0.9.106')
    expect(updatedNoticeVersion('0.9.106', '0.9.106')).toBeNull()
    expect(updatedNoticeVersion(null, '0.9.106')).toBeNull()
  })

  it('links the release notes of the version', () => {
    expect(releaseNotesUrl('0.9.106')).toBe('https://github.com/tejasnafde/switchboard/releases/tag/v0.9.106')
  })
})

describe('statusWhileReady', () => {
  const ready: UpdateStatus = { kind: 'downloaded', version: '1.2.0' }

  it('passes every status through before a download', () => {
    expect(statusWhileReady(null, { kind: 'checking' })).toEqual({ kind: 'checking' })
  })

  // A failed hourly check must not take the Restart button away.
  it('keeps the downloaded update through a later check, its progress or failure', () => {
    const later: UpdateStatus[] = [
      { kind: 'checking' },
      { kind: 'available', version: '1.3.0' },
      { kind: 'downloading', percent: 10 },
      { kind: 'error', message: 'offline' },
      { kind: 'slow', message: 'still checking' },
    ]
    for (const status of later) expect(statusWhileReady(ready, status)).toBe(ready)
  })

  it('lets installing and a newer download through', () => {
    expect(statusWhileReady(ready, { kind: 'installing' })).toEqual({ kind: 'installing' })
    expect(statusWhileReady(ready, { kind: 'downloaded', version: '1.3.0' })).toEqual({
      kind: 'downloaded',
      version: '1.3.0',
    })
  })
})

import { describe, it, expect } from 'vitest'
import { updateRowView, updateStatusLabel } from '../../src/renderer/components/settings/updateRowModel'
import type { UpdateStatus } from '../../src/shared/update-status'

const downloaded: UpdateStatus = { kind: 'downloaded', version: '0.7.29' }

describe('updateRowView', () => {
  it('shows an enabled restart button once an update is downloaded', () => {
    const view = updateRowView(downloaded, { checking: false, restarting: false })
    expect(view.showRestart).toBe(true)
    expect(view.restartDisabled).toBe(false)
    expect(view.restartLabel).toBe('Restart and install')
  })

  it('disables the restart button and swaps the label while restarting', () => {
    const view = updateRowView(downloaded, { checking: false, restarting: true })
    expect(view.showRestart).toBe(true)
    expect(view.restartDisabled).toBe(true)
    expect(view.restartLabel).toBe('Restarting…')
    expect(view.restartSpinning).toBe(true)
  })

  it('also disables the check button while restarting', () => {
    const view = updateRowView(downloaded, { checking: false, restarting: true })
    expect(view.checkDisabled).toBe(true)
  })

  it('keeps the restart button visible but disabled while installing', () => {
    // Main latches the install globally, so a Settings remount (which resets
    // the local `restarting` flag) must still render the pending state.
    const view = updateRowView({ kind: 'installing' }, { checking: false, restarting: false })
    expect(view.showRestart).toBe(true)
    expect(view.restartDisabled).toBe(true)
    expect(view.restartSpinning).toBe(true)
    expect(view.restartLabel).toBe('Restarting…')
    expect(view.checkDisabled).toBe(true)
  })

  it('hides the restart button for every non-downloaded status', () => {
    const statuses: UpdateStatus[] = [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'downloading', percent: 40 },
      { kind: 'up-to-date', version: '0.7.28' },
      { kind: 'available', version: '0.7.29' },
      { kind: 'error', message: 'nope' },
      { kind: 'unsupported', reason: 'dev build' },
    ]
    for (const status of statuses) {
      expect(updateRowView(status, { checking: false, restarting: false }).showRestart).toBe(false)
    }
  })

  it('disables the check button while a check or download is in flight', () => {
    expect(updateRowView({ kind: 'checking' }, { checking: false, restarting: false }).checkDisabled).toBe(true)
    expect(updateRowView({ kind: 'downloading', percent: 10 }, { checking: false, restarting: false }).checkDisabled).toBe(true)
    expect(updateRowView({ kind: 'idle' }, { checking: true, restarting: false }).checkDisabled).toBe(true)
    expect(updateRowView({ kind: 'idle' }, { checking: false, restarting: false }).checkDisabled).toBe(false)
  })
})

describe('updateStatusLabel', () => {
  // Reopening Settings mid-install remounts the row with `restarting` false,
  // so the label has to come from the status alone or it renders blank.
  it('explains the installing status', () => {
    expect(updateStatusLabel({ kind: 'installing' })).toBe('Restarting to install the update…')
  })

  it('returns a non-empty label for every status kind', () => {
    const statuses: UpdateStatus[] = [
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'up-to-date', version: '0.7.28' },
      { kind: 'available', version: '0.7.29' },
      { kind: 'downloading', percent: 40 },
      { kind: 'downloaded', version: '0.7.29' },
      { kind: 'installing' },
      { kind: 'error', message: 'nope' },
      { kind: 'unsupported', reason: 'dev build' },
    ]
    for (const status of statuses) {
      expect(updateStatusLabel(status)).toMatch(/\S/)
    }
  })

  it('includes the version and percent details', () => {
    expect(updateStatusLabel({ kind: 'up-to-date', version: '1.2.3' })).toContain('1.2.3')
    expect(updateStatusLabel({ kind: 'downloading', percent: 42 })).toContain('42')
    expect(updateStatusLabel({ kind: 'error', message: 'boom' })).toContain('boom')
  })
})

describe('slow check', () => {
  // A check past the deadline is still running, so the row must not say
  // "Couldn't check" or render in the error colour. It reports the wait.
  it('reports the wait verbatim rather than prefixing it as a failure', () => {
    expect(updateStatusLabel({ kind: 'slow', message: 'Still checking. Slow network.' }))
      .toBe('Still checking. Slow network.')
  })

  it('keeps the check button busy while the request is still in flight', () => {
    const view = updateRowView({ kind: 'slow', message: 'Still checking.' }, { checking: false, restarting: false })
    expect(view.checkDisabled).toBe(true)
  })
})

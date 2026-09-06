/**
 * The instance rail in UnifiedProviderPicker.tsx collapsed whenever the
 * active agent had fewer than 2 ENABLED instances - but the stored/selected
 * `instanceId` could name a row that was just deleted or disabled elsewhere
 * (another tab, the phone, Settings), leaving exactly one enabled sibling.
 * The old `instances.length >= 2` condition hid the rail in that exact case,
 * so a silent one-instance fallback repointed the session with no visible
 * indication anything changed and no way to pick a different one.
 */
import { describe, it, expect } from 'vitest'
import { shouldShowInstanceRail } from '../../src/renderer/shared/instanceRailVisibility'

describe('shouldShowInstanceRail', () => {
  it('shows the rail whenever 2+ enabled instances exist, regardless of selection', () => {
    const instances = [{ id: 'a' }, { id: 'b' }]
    expect(shouldShowInstanceRail(instances, 'a')).toBe(true)
    expect(shouldShowInstanceRail(instances, undefined)).toBe(true)
  })

  it('collapses with a single enabled instance when it is the one selected', () => {
    expect(shouldShowInstanceRail([{ id: 'a' }], 'a')).toBe(false)
  })

  it('collapses with a single enabled instance and no explicit selection', () => {
    // Nothing to repair - the caller will simply use the sole default.
    expect(shouldShowInstanceRail([{ id: 'a' }], undefined)).toBe(false)
  })

  it('stays visible with one enabled sibling when the stored id is missing or disabled', () => {
    // The repair case: the conversation/machine default names a row that
    // is no longer an enabled member of `instances` (deleted or disabled).
    expect(shouldShowInstanceRail([{ id: 'a' }], 'deleted-or-disabled-id')).toBe(true)
  })

  it('collapses again once the missing instance is re-enabled and matches', () => {
    // Re-enable remains valid: once the previously-missing row is back in
    // the enabled set and selected, normal single-instance collapse resumes.
    expect(shouldShowInstanceRail([{ id: 'a' }], 'a')).toBe(false)
  })

  it('hides with zero instances and no selection', () => {
    expect(shouldShowInstanceRail([], undefined)).toBe(false)
  })
})

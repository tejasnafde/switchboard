/**
 * The Updates footer used to blast every user with a paragraph mixing macOS
 * and Windows first-run instructions. It is now one short line plus a
 * platform-specific tooltip on an info affordance.
 */
import { describe, it, expect } from 'vitest'
import { updateFooterCopy } from '../../src/renderer/components/settings/update-footer-copy'

describe('updateFooterCopy', () => {
  it('gives macOS users only the Gatekeeper detail, xattr command included', () => {
    const copy = updateFooterCopy('darwin', false)
    expect(copy.line).toBe('Updates are checked automatically at launch. This build is unsigned.')
    expect(copy.tooltip).toContain('Gatekeeper')
    expect(copy.tooltip).toContain('xattr -dr com.apple.quarantine /Applications/Switchboard.app')
    expect(copy.tooltip).not.toContain('Windows')
  })

  it('gives Windows users only the SmartScreen detail', () => {
    const copy = updateFooterCopy('win32', false)
    expect(copy.line).toBe('Updates are checked automatically at launch. This build is unsigned.')
    expect(copy.tooltip).toContain('More info')
    expect(copy.tooltip).toContain('Run anyway')
    expect(copy.tooltip).not.toContain('xattr')
  })

  it('says nothing about signing on a signed release', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(updateFooterCopy(platform, true)).toEqual({
        line: 'Updates are checked automatically at launch.',
        tooltip: null,
      })
    }
  })

  it('gives other platforms the line with no tooltip', () => {
    expect(updateFooterCopy('linux', false).tooltip).toBeNull()
  })
})

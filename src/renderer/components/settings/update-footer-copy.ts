/**
 * Updates-section footer: one short line, with the unsigned-build first-run
 * instructions tucked into a platform-specific tooltip instead of a paragraph
 * that named every OS at once.
 */
export interface UpdateFooterCopy {
  line: string
  /** Tooltip for the info affordance; null hides the affordance. */
  tooltip: string | null
}

const LINE = 'Updates are checked automatically at launch. Builds are unsigned.'

export function updateFooterCopy(platform: NodeJS.Platform | string): UpdateFooterCopy {
  if (platform === 'darwin') {
    return {
      line: LINE,
      tooltip: 'Gatekeeper may re-quarantine each new version. Right-click the app and choose Open, or run: xattr -dr com.apple.quarantine /Applications/Switchboard.app',
    }
  }
  if (platform === 'win32') {
    return {
      line: LINE,
      tooltip: 'SmartScreen may warn on the first run of a new version. Click "More info", then "Run anyway". First run only.',
    }
  }
  return { line: LINE, tooltip: null }
}

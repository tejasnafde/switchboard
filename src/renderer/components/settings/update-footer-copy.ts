/**
 * Updates-section footer: one short line. An unsigned build (a local or dev
 * build) adds the first-run instructions in a platform-specific tooltip; a
 * signed and notarized release says nothing about signing.
 */
export interface UpdateFooterCopy {
  line: string
  /** Tooltip for the info affordance; null hides the affordance. */
  tooltip: string | null
}

const LINE = 'Updates are checked automatically at launch.'
const UNSIGNED_LINE = `${LINE} This build is unsigned.`

export function updateFooterCopy(platform: NodeJS.Platform | string, signed: boolean): UpdateFooterCopy {
  if (signed) return { line: LINE, tooltip: null }
  if (platform === 'darwin') {
    return {
      line: UNSIGNED_LINE,
      tooltip:
        'Release builds are signed and notarized. This local build is not, so Gatekeeper may block each new version. Right-click the app and choose Open, or run: xattr -dr com.apple.quarantine /Applications/Switchboard.app',
    }
  }
  if (platform === 'win32') {
    return {
      line: UNSIGNED_LINE,
      tooltip:
        'This build is not signed, so SmartScreen may warn on the first run of a new version. Click "More info", then "Run anyway". First run only.',
    }
  }
  return { line: UNSIGNED_LINE, tooltip: null }
}

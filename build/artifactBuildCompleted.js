'use strict'

/** v0.8.35 ships electron-updater 6.8.3, which compares this field with
 * os.release() (the Darwin kernel), not the marketing macOS version. Electron
 * 43 requires macOS 12, whose Darwin floor is 21.0.0. Keep this separate from
 * mac.minimumSystemVersion, which correctly uses the marketing version. */
module.exports = function artifactBuildCompleted(event) {
  if (event.packager?.platform?.nodeName !== 'darwin' || !event.file?.endsWith('.zip')) return
  // electron-builder treats any custom updateInfo containing sha512 as file
  // metadata and nests every custom key under files[0]. Remove the precomputed
  // hash so it recalculates it and keeps this compatibility floor top-level,
  // where electron-updater's AppUpdater reads it.
  event.updateInfo = {
    ...(event.updateInfo ?? {}),
    minimumSystemVersion: '21.0.0',
  }
  delete event.updateInfo.sha512
}

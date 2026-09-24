/**
 * Pixel comparison for the visual regression suite. Pure over PNG buffers
 * (pngjs), so tests/unit/visual-compare.test.ts covers it without Electron.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'

/** A pixel counts as changed when any RGBA channel moves by more than this. */
export const DEFAULT_CHANNEL_TOLERANCE = 12
/** A screen fails when more than this fraction of its pixels changed. */
export const DEFAULT_MAX_CHANGED_RATIO = 0.005

// Two muted colours split down the middle. Anything the app draws with alpha
// below 1 shows one or both of them, so a translucent surface that turns
// opaque (or an opaque one that turns see-through) changes pixels.
const BACKDROP_LEFT = [196, 98, 72]
const BACKDROP_RIGHT = [58, 118, 186]

/**
 * Composite a capture over the fixed backdrop and drop the alpha channel.
 * Playwright's screenshot of a transparent Electron window holds only the
 * app's own pixels (straight alpha); the desktop and the native vibrancy
 * material behind them are not in it. Flattening over a known backdrop makes
 * that capture deterministic and lets a reviewer see what is transmitted.
 */
export function flattenOverBackdrop(buffer) {
  const png = PNG.sync.read(buffer)
  const half = png.width / 2
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4
      const alpha = png.data[offset + 3] / 255
      const backdrop = x < half ? BACKDROP_LEFT : BACKDROP_RIGHT
      for (let channel = 0; channel < 3; channel++) {
        png.data[offset + channel] = Math.round(png.data[offset + channel] * alpha + backdrop[channel] * (1 - alpha))
      }
      png.data[offset + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

/**
 * Compare two PNG buffers. The diff image fades the baseline and paints every
 * changed pixel red; it is null when the sizes differ.
 */
export function comparePng(expectedBuffer, actualBuffer, {
  channelTolerance = DEFAULT_CHANNEL_TOLERANCE,
  maxChangedRatio = DEFAULT_MAX_CHANGED_RATIO,
} = {}) {
  const expected = PNG.sync.read(expectedBuffer)
  const actual = PNG.sync.read(actualBuffer)
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      ok: false,
      ratio: 1,
      diff: null,
      reason: `size changed from ${expected.width}x${expected.height} to ${actual.width}x${actual.height}`,
    }
  }
  const diff = new PNG({ width: actual.width, height: actual.height })
  let changed = 0
  for (let i = 0; i < actual.data.length; i += 4) {
    let delta = 0
    for (let channel = 0; channel < 4; channel++) {
      delta = Math.max(delta, Math.abs(actual.data[i + channel] - expected.data[i + channel]))
    }
    if (delta > channelTolerance) {
      changed++
      diff.data.set([255, 0, 0, 255], i)
    } else {
      const grey = Math.round((expected.data[i] + expected.data[i + 1] + expected.data[i + 2]) / 3)
      const faded = Math.round(255 - (255 - grey) * 0.25)
      diff.data.set([faded, faded, faded, 255], i)
    }
  }
  const ratio = changed / (actual.width * actual.height)
  const ok = ratio <= maxChangedRatio
  return {
    ok,
    ratio,
    diff: ok ? null : PNG.sync.write(diff),
    reason: ok ? null : `${(ratio * 100).toFixed(2)}% of pixels changed (limit ${(maxChangedRatio * 100).toFixed(2)}%)`,
  }
}

/**
 * Check a capture against `<snapshotDir>/<name>.png`, or rewrite that
 * baseline when `update` is set. On failure the actual capture and the diff
 * land in `artifactDir` as `<name>-actual.png` and `<name>-diff.png`.
 * Returns an error message, or null when the capture matches.
 */
export function checkBaseline({ name, actual, snapshotDir, artifactDir, update, ...tolerance }) {
  const baselinePath = join(snapshotDir, `${name}.png`)
  if (update) {
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(baselinePath, actual)
    return null
  }
  mkdirSync(artifactDir, { recursive: true })
  if (!existsSync(baselinePath)) {
    writeFileSync(join(artifactDir, `${name}-actual.png`), actual)
    return `${name}: missing baseline ${baselinePath} (run with SB_UPDATE_SNAPSHOTS=1)`
  }
  const result = comparePng(readFileSync(baselinePath), actual, tolerance)
  if (result.ok) return null
  writeFileSync(join(artifactDir, `${name}-actual.png`), actual)
  if (result.diff) writeFileSync(join(artifactDir, `${name}-diff.png`), result.diff)
  return `${name}: ${result.reason}`
}

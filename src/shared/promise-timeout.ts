/**
 * Race a promise against a timer. On timeout, rejects with a descriptive
 * error mentioning the operation name so the surfaced message is
 * actionable ("Update check timed out after 30000ms").
 *
 * Extracted from codex-adapter's private copy so the auto-updater can wrap
 * `autoUpdater.checkForUpdates()`, whose HTTP request has no deadline of
 * its own - one stalled request otherwise pins the Settings row on
 * "Checking..." until the app restarts.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, opName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${opName} timed out after ${ms}ms`))
    }, ms)
    p.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

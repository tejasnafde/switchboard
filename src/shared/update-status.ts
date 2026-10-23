/**
 * Auto-update lifecycle states emitted by main → renderer.
 *
 * Lives in `shared` (not `main`) so preload + renderer can import the
 * type without crossing process boundaries. Actual emission happens in
 * `src/main/updater.ts`.
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  /** User asked to restart-and-install; main has latched the request. */
  | { kind: 'installing' }
  | { kind: 'error'; message: string }
  /**
   * Past the deadline but still in flight. Distinct from `error` because the
   * check usually succeeds afterwards and overwrites this, so the row must not
   * call it a failure.
   */
  | { kind: 'slow'; message: string }
  /** Dev / non-packaged build - updater can't run, surfaced as info. */
  | { kind: 'unsupported'; reason: string }

/**
 * What to report while a downloaded update waits for a restart. A later check
 * (and its progress or failure) does not make that update less installable, so
 * the status stays `downloaded` and the Restart button stays. `installing` and
 * a newer `downloaded` pass through.
 */
export function statusWhileReady(ready: UpdateStatus | null, status: UpdateStatus): UpdateStatus {
  if (!ready || status.kind === 'downloaded' || status.kind === 'installing') return status
  return ready
}

/** The version to announce as "Updated to" after a launch, or null on a first run or the same version. */
export function updatedNoticeVersion(lastRunVersion: string | null, currentVersion: string): string | null {
  return lastRunVersion && lastRunVersion !== currentVersion ? currentVersion : null
}

export function releaseNotesUrl(version: string): string {
  return `https://github.com/tejasnafde/switchboard/releases/tag/v${version}`
}

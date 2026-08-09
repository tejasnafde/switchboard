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

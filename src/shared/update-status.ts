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
  | { kind: 'error'; message: string }
  /** Dev / non-packaged build — updater can't run, surfaced as info. */
  | { kind: 'unsupported'; reason: string }

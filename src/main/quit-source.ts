/**
 * Who asked the app to quit. Every in-app quit path names itself before it
 * calls app.quit(); the first name wins, and `before-quit` logs it once. A
 * quit with no name came from outside the app code: the Dock, a macOS quit
 * Apple event, or a caller we have not tagged yet.
 */
export type QuitSourceKind =
  | 'menu'
  | 'relaunch'
  | 'update-install'
  | 'window-all-closed'
  | 'single-instance-lock'
  | 'stale-dev-instance'
  | 'fatal-startup'
  | 'smoke-test'
  | 'os-shutdown'
  | 'signal'
  | 'system'

export interface QuitSource {
  kind: QuitSourceKind
  detail?: string
}

let noted: QuitSource | null = null

/** Records why the app is quitting; a later call does not overwrite the first reason. */
export function noteQuitSource(kind: QuitSourceKind, detail?: string): void {
  if (!noted) noted = detail ? { kind, detail } : { kind }
}

/** The recorded reason, or `system` when nothing in the app asked to quit. */
export function quitSource(): QuitSource {
  return noted ?? { kind: 'system', detail: 'no in-app caller: Dock, a macOS quit event, or an untagged path' }
}

/** Test seam. */
export function resetQuitSourceForTests(): void {
  noted = null
}

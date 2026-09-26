/**
 * While Settings records a new shortcut, the app menu's own items stand down,
 * so pressing ⌘R to record it does not open the reload dialog. The renderer
 * reports the state over a desktop-only IPC; main clears it whenever the page
 * reloads, crashes or closes, so it cannot stick. Role items (Quit, Hide,
 * Copy...) are left alone: their keys are refused by the recorder anyway, and
 * ⌘Q still quitting is what the user means.
 */
let capturing = false

export function setMenuCapture(on: boolean): void {
  capturing = on
}

export const isMenuCaptureActive = (): boolean => capturing

/** A menu click handler that does nothing while a shortcut is being recorded. */
export function unlessCapturing<A extends unknown[]>(handler: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    if (!capturing) handler(...args)
  }
}

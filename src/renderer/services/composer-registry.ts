export interface ComposerHandle {
  focus(atEnd?: boolean): void
}

const composers = new Map<string, ComposerHandle>()

export function registerComposer(sessionId: string, handle: ComposerHandle): () => void {
  composers.set(sessionId, handle)
  return () => {
    if (composers.get(sessionId) === handle) composers.delete(sessionId)
  }
}

/** `atEnd`: put the caret after everything, where text just appended to the draft ends. */
export function focusComposer(sessionId: string, atEnd?: boolean): boolean {
  const handle = composers.get(sessionId)
  if (!handle) return false
  handle.focus(atEnd)
  return true
}

export function clearComposerRegistry(): void {
  composers.clear()
}

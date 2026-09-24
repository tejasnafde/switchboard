export interface ComposerHandle {
  focus(): void
}

const composers = new Map<string, ComposerHandle>()

export function registerComposer(sessionId: string, handle: ComposerHandle): () => void {
  composers.set(sessionId, handle)
  return () => {
    if (composers.get(sessionId) === handle) composers.delete(sessionId)
  }
}

export function focusComposer(sessionId: string): boolean {
  const handle = composers.get(sessionId)
  if (!handle) return false
  handle.focus()
  return true
}

export function clearComposerRegistry(): void {
  composers.clear()
}

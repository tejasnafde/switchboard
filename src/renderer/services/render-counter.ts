/**
 * Dev-only render counter. `useRenderCount(name)` adds one per render of the
 * calling component; read the totals with `renderCounts()` or, in the dev app,
 * `window.__sbRenderCounts()`. Production builds replace `import.meta.env.DEV`
 * with `false`, so the hook body and the map are dropped.
 */
const counts = new Map<string, number>()

export function useRenderCount(name: string): void {
  if (import.meta.env.DEV) counts.set(name, (counts.get(name) ?? 0) + 1)
}

export function renderCounts(): Record<string, number> {
  return Object.fromEntries(counts)
}

export function resetRenderCounts(): void {
  counts.clear()
}

declare global {
  interface Window {
    __sbRenderCounts?: typeof renderCounts
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') window.__sbRenderCounts = renderCounts

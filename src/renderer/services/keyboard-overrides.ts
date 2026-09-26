/**
 * The user's shortcut rebinds, stored as one JSON settings value. Loading
 * applies them to the registry's active list, which every matcher reads, so a
 * change takes effect on the next keydown. The main process re-reads the same
 * value when it is written (menu accelerators, ⌘W).
 */
import { KEYBOARD_OVERRIDES_SETTING, setActiveShortcutOverrides } from '@shared/shortcuts'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:keyboard-overrides')

// Kept as stored, ids this build does not know included, so saving one rebind
// does not erase another build's.
let stored: Record<string, unknown> = {}
let loading: Promise<void> | null = null

function apply(raw: string | null): void {
  const ignored = setActiveShortcutOverrides(raw)
  if (ignored.length > 0) log.warn('ignoring shortcut overrides this build cannot use', ignored)
}

/**
 * Rejects when the read fails, and the next call retries: a write on top of
 * a failed read would erase every other rebind.
 */
export function loadKeyboardOverrides(): Promise<void> {
  loading ??= window.api.settings.get(KEYBOARD_OVERRIDES_SETTING)
    .then((raw) => {
      apply(raw)
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {}
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
      } catch (err) {
        log.warn('stored shortcut overrides are not JSON; starting from the defaults', err)
      }
    })
    .catch((err) => {
      loading = null
      throw err
    })
  return loading
}

/** `bindings` replaces the defaults (`[]` unbinds); null goes back to the default. */
export async function setKeyboardOverride(id: string, bindings: string[] | null): Promise<void> {
  await loadKeyboardOverrides()
  const next = { ...stored }
  if (bindings === null) delete next[id]
  else next[id] = bindings
  stored = next
  const raw = JSON.stringify(next)
  apply(raw)
  await window.api.settings.set(KEYBOARD_OVERRIDES_SETTING, raw)
}

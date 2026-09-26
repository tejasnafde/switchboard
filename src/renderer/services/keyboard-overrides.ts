/**
 * The user's shortcut rebinds, stored as one JSON settings value. Loading
 * applies them to the registry's active list, which every matcher reads, so a
 * change takes effect on the next keydown. The main process re-reads the same
 * value when it is written (menu accelerators, ⌘W) and tells the window, which
 * re-reads too, so the window, the menu and the stored value agree whoever
 * wrote it.
 */
import { KEYBOARD_OVERRIDES_SETTING, setActiveShortcutOverrides } from '@shared/shortcuts'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:keyboard-overrides')

// Kept as stored, ids this build does not know included, so saving one rebind
// does not erase another build's.
let stored: Record<string, unknown> = {}
let loading: Promise<void> | null = null
// Bumped by every write, so a re-read that raced one does not undo it.
let writes = 0

function adopt(raw: string | null): void {
  const ignored = setActiveShortcutOverrides(raw)
  if (ignored.length > 0) log.warn('ignoring shortcut overrides this build cannot use', ignored)
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    stored = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch (err) {
    stored = {}
    log.warn('stored shortcut overrides are not JSON; starting from the defaults', err)
  }
}

/**
 * Rejects when the read fails, and the next call retries: a write on top of
 * a failed read would erase every other rebind.
 */
export function loadKeyboardOverrides(): Promise<void> {
  loading ??= window.api.settings.get(KEYBOARD_OVERRIDES_SETTING)
    .then(adopt)
    .catch((err) => {
      loading = null
      throw err
    })
  return loading
}

/** Re-reads the stored value, unless a write started meanwhile (its own notice follows). */
export async function reloadKeyboardOverrides(): Promise<void> {
  const before = writes
  const raw = await window.api.settings.get(KEYBOARD_OVERRIDES_SETTING)
  if (writes !== before) return
  adopt(raw)
  loading = Promise.resolve()
}

// Writes run one at a time: each one rewrites the whole value, so Reset all's
// row-by-row writes must each start from the one before, and none may land
// after a later one.
let queue: Promise<void> = Promise.resolve()

/** `bindings` replaces the defaults (`[]` unbinds); null goes back to the default. */
export function setKeyboardOverride(id: string, bindings: string[] | null): Promise<void> {
  const run = queue.then(() => writeOverride(id, bindings))
  queue = run.catch((err) => log.warn(`writing the shortcut override for ${id} failed`, err))
  return run
}

async function writeOverride(id: string, bindings: string[] | null): Promise<void> {
  await loadKeyboardOverrides()
  const next = { ...stored }
  if (bindings === null) delete next[id]
  else next[id] = bindings
  const raw = JSON.stringify(next)
  writes += 1
  adopt(raw)
  try {
    await window.api.settings.set(KEYBOARD_OVERRIDES_SETTING, raw)
  } catch (err) {
    // Main rebuilds its menu only after a successful write, so go back to what
    // is stored instead of keeping keys the menu and the next launch lack.
    await reloadKeyboardOverrides().catch((reloadErr) => log.warn('re-reading shortcut overrides failed', reloadErr))
    throw err
  }
}

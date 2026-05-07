/**
 * Per-Settings preference for "default workspace mode for new sessions".
 * Mirrors the t3code `defaultThreadEnvMode` setting:
 *
 *   - 'local'    → new sessions run in the project root cwd (current behavior)
 *   - 'worktree' → new sessions get a fresh `git worktree` off HEAD; the
 *                  worktree path becomes the session's cwd, so two
 *                  parallel sessions on the same project don't fight
 *                  over the same checkout
 *
 * The cache pattern mirrors `notifications.ts` — one read on first
 * access, one write to flip; persisted via the existing settings KV.
 */
export type SessionEnvMode = 'local' | 'worktree'

const SETTING_KEY = 'defaultSessionEnvMode'
const DEFAULT_MODE: SessionEnvMode = 'local'

let cached: SessionEnvMode | null = null

function isMode(value: string): value is SessionEnvMode {
  return value === 'local' || value === 'worktree'
}

export async function getDefaultSessionEnvMode(): Promise<SessionEnvMode> {
  if (cached !== null) return cached
  try {
    const raw = await window.api.settings.get(SETTING_KEY)
    cached = raw && isMode(raw) ? raw : DEFAULT_MODE
  } catch {
    cached = DEFAULT_MODE
  }
  return cached
}

export async function setDefaultSessionEnvMode(mode: SessionEnvMode): Promise<void> {
  cached = mode
  try {
    await window.api.settings.set(SETTING_KEY, mode)
  } catch {
    /* best-effort */
  }
}

export function invalidateSessionEnvModeCache(): void {
  cached = null
}

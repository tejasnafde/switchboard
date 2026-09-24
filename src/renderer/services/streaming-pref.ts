/**
 * Per-user "Stream assistant messages" preference. When enabled
 * (default), the renderer applies content events token-by-token to the
 * message bubble. When disabled, ChatPanel buffers content events and
 * flushes once on turn.completed (see streaming-buffer.ts).
 *
 * Same persistence + cache pattern as `notifications.ts` and
 * `session-env-mode.ts` - one read on first access, one write to flip;
 * settings KV is the source of truth.
 */
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:streaming-pref')

const SETTING_KEY = 'assistantStreamingEnabled'
const DEFAULT_ENABLED = true

let cached: boolean | null = null

export async function isAssistantStreamingEnabled(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    const raw = await window.api.settings.get(SETTING_KEY)
    cached = raw === null ? DEFAULT_ENABLED : raw !== 'false'
  } catch {
    cached = DEFAULT_ENABLED
  }
  return cached
}

export async function setAssistantStreamingEnabled(enabled: boolean): Promise<void> {
  cached = enabled
  try {
    await window.api.settings.set(SETTING_KEY, enabled ? 'true' : 'false')
  } catch (err) {
    log.warn('failed to persist assistantStreamingEnabled setting', err)
  }
}

export function invalidateStreamingCache(): void {
  cached = null
}

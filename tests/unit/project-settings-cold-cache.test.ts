/**
 * The first new chat in a project after launch: the renderer's override
 * cache is still empty when the chat picks its mode. Reading it
 * synchronously took the global mode, and the chat sent that explicitly, so
 * the backend's own resolution never ran and the override was lost. Every
 * value picked once at creation now waits for the project's overrides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoreDefaultRuntimeMode } from '../../src/renderer/stores/agent-store'
import { useProjectSettingsStore, ensureProjectOverrides } from '../../src/renderer/stores/project-settings-store'
import { newChatDefaultsFor } from '../../src/renderer/services/effective-settings'
import { invalidateSessionEnvModeCache } from '../../src/renderer/services/session-env-mode'
import { resolveCardRuntimeMode } from '../../src/renderer/components/kanban/card-launch'

const APP = '/work/app'
const OTHER = '/work/other'

let projectOverrides: ReturnType<typeof vi.fn>

beforeEach(() => {
  useProjectSettingsStore.setState({ byProject: {} })
  setStoreDefaultRuntimeMode('accept-edits')
  invalidateSessionEnvModeCache()
  // The backend answers after a round trip, as over IPC.
  projectOverrides = vi.fn(async (paths: string[]) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return Object.fromEntries(paths.map((path) => [
      path,
      path === APP ? { 'chat.defaultRuntimeMode': 'plan', defaultSessionEnvMode: 'worktree' } : {},
    ]))
  })
  ;(globalThis as { window?: unknown }).window = {
    api: { settings: { projectOverrides, get: async () => null } },
  }
})

describe('the first new chat in a project, with a cold cache', () => {
  it('starts in the project\'s override, not the global mode', async () => {
    expect(await newChatDefaultsFor(APP)).toEqual({ runtimeMode: 'plan', envMode: 'worktree' })
  })

  it('lets the override beat a mode carried over from the focused chat, and only the override', async () => {
    expect((await newChatDefaultsFor(APP, 'full-access')).runtimeMode).toBe('plan')
    expect((await newChatDefaultsFor(OTHER, 'full-access')).runtimeMode).toBe('full-access')
    expect(await newChatDefaultsFor(OTHER)).toEqual({ runtimeMode: 'accept-edits', envMode: 'local' })
  })

  it('launches a kanban card with no mode of its own in the project\'s override', async () => {
    expect(await resolveCardRuntimeMode(null, null, APP)).toBe('plan')
  })

  it('reads a project once however many callers wait on it, and not again once cached', async () => {
    await Promise.all([ensureProjectOverrides(APP), ensureProjectOverrides(APP), newChatDefaultsFor(APP)])
    await ensureProjectOverrides(APP)
    expect(projectOverrides).toHaveBeenCalledTimes(1)
  })

  it('asks again after a failed read instead of caching the failure', async () => {
    projectOverrides.mockRejectedValueOnce(new Error('backend restarting'))
    expect((await newChatDefaultsFor(APP)).runtimeMode).toBe('accept-edits')
    expect((await newChatDefaultsFor(APP)).runtimeMode).toBe('plan')
  })
})
